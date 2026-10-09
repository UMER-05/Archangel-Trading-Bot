// backend/src/services/execution/executionRouter.service.ts
//
// The concrete mechanism behind "additive, not a replacement": the one
// place that decides, per candidate, whether a buy goes through a
// Raydium-native executor or through the existing (audited-by-usage)
// Jupiter path. Ships behind RAYDIUM_NATIVE_EXECUTION_ENABLED, defaulting
// off, with Jupiter still handling every real trade until it's proven
// out. "Can we turn it off instantly and fall back" is the whole point of
// this file existing as its own module rather than an inline branch
// inside candidatePipeline.service.ts.
//
// Routing decision, in order — any "no" falls through to Jupiter:
//   1. Is RAYDIUM_NATIVE_EXECUTION_ENABLED set at all?
//   2. Does the candidate's dex map to a pinned Raydium pool type?
//   3. Does an executor actually exist in NATIVE_EXECUTOR_REGISTRY for it?
//   4. Does the pool verify on-chain (poolVerification.service.ts) as
//      genuinely owned by that program?
// A "yes" through all four runs the real per-wallet fan-out (see
// runPipelineForAllEligibleWallets's injected-runner parameter and
// validationPipelineService.runNativePipeline) inside a try/catch: an
// unexpected error from the whole fan-out call falls back to Jupiter for
// this candidate rather than failing the buy outright. Per-wallet
// failures within a successful fan-out are NOT caught here — they're
// already handled per-wallet inside runPipelineForAllEligibleWallets,
// same as a per-wallet Jupiter failure always was.
import { getLogger } from "../../utils/logger.js";
import type { CandidateMint } from "../tokenExtraction.service.js";
import multiUserExecutionService, {
  FanOutResult,
} from "../multiUserExecution.service.js";
import validationPipelineService from "../validationPipeline.service.js";
import { verifyRaydiumPool } from "./poolVerification.service.js";
import { NATIVE_EXECUTOR_REGISTRY } from "./nativeExecutor.types.js";
import { toCanonicalRaydiumPoolType } from "./raydiumProgramIds.js";

const LOG = getLogger("execution-router");

export type ExecutionRoute = "raydium-native" | "jupiter";

export interface RouterResult {
  route: ExecutionRoute;
  fanOutResults: FanOutResult[];
  // Populated only when route === "jupiter" but a native attempt was made
  // first and failed — distinct from "native was never eligible," so this
  // is visible in logs/metrics as a real fallback event, not routine.
  nativeFallbackReason?: string;
}

function isNativeExecutionEnabled(): boolean {
  return process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED === "true";
}

// Small in-memory counter feeding a log-level alert — see doc 13's point
// about needing an explicit failed-transaction-rate alert once Jupiter's
// own automatic-reroute resilience is no longer sitting in front of every
// trade. Wire this into real alerting (Telegram/email via
// notifications/notify.service.ts) before relying on it in production;
// today it's log-only. Only increments when the ENTIRE fan-out call
// throws — an unexpected error, not a per-wallet business failure (those
// are recorded as individual failed FanOutResult entries and don't count
// here, same as a per-wallet Jupiter failure never did either).
let consecutiveNativeFailures = 0;
const NATIVE_FAILURE_ALERT_THRESHOLD = 3;

async function runJupiterPath(
  candidate: CandidateMint,
  liquiditySol: number,
): Promise<FanOutResult[]> {
  return multiUserExecutionService.runPipelineForAllEligibleWallets(
    candidate.mint,
    liquiditySol,
  );
}

/**
 * Single entry point for turning an approved candidate into buys.
 * candidatePipeline.service.ts calls this in place of calling
 * multiUserExecutionService directly — the Jupiter fan-out logic itself
 * (eligible-wallet selection, per-wallet mutex, position bookkeeping) is
 * unchanged and still lives in multiUserExecution.service.ts.
 */
export async function routeExecution(
  candidate: CandidateMint,
  liquiditySol: number,
): Promise<RouterResult> {
  if (!isNativeExecutionEnabled()) {
    return {
      route: "jupiter",
      fanOutResults: await runJupiterPath(candidate, liquiditySol),
    };
  }

  const poolType = toCanonicalRaydiumPoolType(candidate.dex);
  if (!poolType) {
    LOG.debug(
      { mint: candidate.mint.slice(0, 8), dex: candidate.dex },
      "Native execution enabled, but dex doesn't map to a pinned Raydium pool type — using Jupiter",
    );
    return {
      route: "jupiter",
      fanOutResults: await runJupiterPath(candidate, liquiditySol),
    };
  }
  const executor = NATIVE_EXECUTOR_REGISTRY.get(poolType);
  if (!executor) {
    LOG.debug(
      { mint: candidate.mint.slice(0, 8), dex: candidate.dex },
      "Native execution enabled, but no executor registered for this dex — using Jupiter",
    );
    return {
      route: "jupiter",
      fanOutResults: await runJupiterPath(candidate, liquiditySol),
    };
  }

  const verification = await verifyRaydiumPool(
    candidate.dex,
    candidate.poolAddress,
  );
  if (!verification.verified) {
    LOG.warn(
      {
        mint: candidate.mint.slice(0, 8),
        poolAddress: candidate.poolAddress,
        reason: verification.reason,
      },
      "Pool failed on-chain verification — falling back to Jupiter",
    );
    return {
      route: "jupiter",
      fanOutResults: await runJupiterPath(candidate, liquiditySol),
      ...(verification.reason !== undefined
        ? { nativeFallbackReason: verification.reason }
        : {}),
    };
  }

  try {
    // The real per-wallet fan-out: eligibility checks, mutex locking, and
    // position-metadata recording are all reused verbatim from the
    // Jupiter path via runPipelineForAllEligibleWallets's injected-runner
    // parameter (see multiUserExecution.service.ts) — this closure is the
    // ONLY thing that differs. A per-wallet native failure is recorded as
    // that wallet's own failed FanOutResult entry, the same way a
    // per-wallet Jupiter failure already is — there is no per-wallet
    // "retry this one wallet via Jupiter instead" here, because the
    // existing Jupiter-only fan-out never had that feature either; adding
    // it would be new behavior, not parity.
    const fanOutResults =
      await multiUserExecutionService.runPipelineForAllEligibleWallets(
        candidate.mint,
        liquiditySol,
        (tokenMint, lpSol, walletContext) =>
          validationPipelineService.runNativePipeline(
            tokenMint,
            walletContext,
            (buySol, ctx) => executor.buy(candidate, buySol, ctx),
            poolType,
          ),
      );
    consecutiveNativeFailures = 0;
    return { route: "raydium-native", fanOutResults };
  } catch (err: any) {
    consecutiveNativeFailures += 1;
    if (consecutiveNativeFailures >= NATIVE_FAILURE_ALERT_THRESHOLD) {
      LOG.error(
        { consecutiveNativeFailures, mint: candidate.mint.slice(0, 8) },
        "🚨 Native execution has failed repeatedly in a row — wire this to real alerting before enabling in production",
      );
    }
    LOG.warn(
      { mint: candidate.mint.slice(0, 8), err: err?.message },
      "Native execution attempt failed — falling back to Jupiter for this candidate",
    );
    const reason: string | undefined = err?.message;
    return {
      route: "jupiter",
      fanOutResults: await runJupiterPath(candidate, liquiditySol),
      ...(reason !== undefined ? { nativeFallbackReason: reason } : {}),
    };
  }
}

export default { routeExecution };
