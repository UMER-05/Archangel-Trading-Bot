// backend/src/services/execution/sellExecutionRouter.service.ts
//
// Sell-side counterpart to executionRouter.service.ts, and the fix for a
// design mistake made while building cpmm.ts's sell(): the position-exit
// claim guard (doc 13 point 9) was originally placed inside the native
// executor itself. That's wrong — a guard living only inside the native
// path can't stop a concurrent JUPITER-path sell for the same position
// from racing it, since a Jupiter sell never calls into cpmm.ts at all.
// The guard has to sit at the one place that decides between native and
// Jupiter BEFORE either path runs. This file is that place, and — same as
// executionRouter.service.ts on the buy side — it's meant to be the ONLY
// caller of cpmm.ts's sell() in production, and the only thing
// monitor.service.ts's three sell call sites (emergency/tiered/final)
// should call.
//
// Routing decision, in order — any "no" falls through to Jupiter,
// unchanged from today's behavior:
//   1. Is RAYDIUM_NATIVE_EXECUTION_ENABLED set at all? (same flag as buys —
//      one on/off switch for native execution generally, not a separate
//      one per direction)
//   2. Does this position's stored `dex` map to a pinned Raydium pool type?
//   3. Does the registered executor for that type implement `sell`?
//   4. Does the pool verify on-chain (poolVerification.service.ts)?
// A native attempt that fails for any reason falls back to Jupiter for
// that same attempt, same "additive, not replacement" principle as buys —
// see the try/catch below.
import type { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { getLogger } from "../../utils/logger.js";
import dbService from "../db.service.js";
import { getJupiterQuote, executeJupiterSwap } from "../jupiter.service.js";
import { NATIVE_EXECUTOR_REGISTRY } from "./nativeExecutor.types.js";
import { toCanonicalRaydiumPoolType } from "./raydiumProgramIds.js";
import { verifyRaydiumPool } from "./poolVerification.service.js";
import * as positionExitCoordinator from "./positionExitCoordinator.service.js";
import type { CandidateMint } from "../tokenExtraction.service.js";

const LOG = getLogger("sell-execution-router");
const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface SellRouteParams {
  tokenMint: string;
  wallet: string;
  /** Raw token base units to sell (NOT a human-readable amount). */
  amountBaseUnits: number;
  slippageBps: number;
  signer: Keypair;
  /** Same meaning as elsewhere in this codebase: false means simulate/quote only. */
  useRealSwap: boolean;
}

export type SellRouteResult = {
  route: "raydium-native" | "jupiter" | "skipped";
  success: boolean;
  signature?: string;
  /** SOL lamports received (or quoted, if !useRealSwap) — same unit addTrade's `amount` field already expects. */
  solLamportsOut: number;
  error?: string;
  nativeFallbackReason?: string;
};

function isNativeExecutionEnabled(): boolean {
  return process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED === "true";
}

async function jupiterSell(
  params: SellRouteParams,
  nativeFallbackReason?: string,
): Promise<SellRouteResult> {
  const quote = await getJupiterQuote(
    params.tokenMint,
    SOL_MINT,
    params.amountBaseUnits,
    params.slippageBps,
  );
  const solLamportsOut = Number(quote?.outAmount ?? 0);

  if (!params.useRealSwap) {
    return {
      route: "jupiter",
      success: true,
      signature: `sim-sell-${Date.now()}`,
      solLamportsOut,
      ...(nativeFallbackReason ? { nativeFallbackReason } : {}),
    };
  }

  const swap = await executeJupiterSwap({
    inputMint: params.tokenMint,
    outputMint: SOL_MINT,
    amount: params.amountBaseUnits,
    userPublicKey: params.signer.publicKey.toBase58(),
    slippageBps: params.slippageBps,
    signer: params.signer,
  });

  return {
    route: "jupiter",
    success: swap.success,
    ...(swap.signature ? { signature: swap.signature } : {}),
    solLamportsOut,
    ...(swap.error ? { error: swap.error } : {}),
    ...(nativeFallbackReason ? { nativeFallbackReason } : {}),
  };
}

async function attemptSell(params: SellRouteParams): Promise<SellRouteResult> {
  if (!isNativeExecutionEnabled()) {
    return jupiterSell(params);
  }

  const tokenState = await dbService.getTokenState(params.tokenMint);
  const dex = tokenState?.dex;
  const poolAddress = tokenState?.poolAddress;
  if (!dex || !poolAddress) {
    LOG.debug(
      { mint: params.tokenMint.slice(0, 8) },
      "No stored dex/poolAddress for this position — using Jupiter",
    );
    return jupiterSell(params);
  }

  const poolType = toCanonicalRaydiumPoolType(dex);
  const executor = poolType
    ? NATIVE_EXECUTOR_REGISTRY.get(poolType)
    : undefined;
  if (!executor?.sell) {
    LOG.debug(
      { mint: params.tokenMint.slice(0, 8), dex },
      "No registered sell-capable executor for this dex — using Jupiter",
    );
    return jupiterSell(params);
  }

  const verification = await verifyRaydiumPool(dex, poolAddress);
  if (!verification.verified) {
    LOG.warn(
      {
        mint: params.tokenMint.slice(0, 8),
        poolAddress,
        reason: verification.reason,
      },
      "Pool failed on-chain verification — falling back to Jupiter for this sell",
    );
    return jupiterSell(params, verification.reason);
  }

  const candidate: CandidateMint = {
    mint: params.tokenMint,
    poolAddress,
    dex,
    poolCreatedAt: tokenState?.poolCreatedAt ?? new Date(),
  };

  try {
    const nativeResult = await executor.sell(
      candidate,
      new BN(Math.floor(params.amountBaseUnits)),
      { ownerWallet: params.wallet, keypair: params.signer },
    );
    if (nativeResult.success) {
      return {
        route: "raydium-native",
        success: true,
        ...(nativeResult.signature
          ? { signature: nativeResult.signature }
          : {}),
        solLamportsOut: Math.round(
          (nativeResult.amountSol ?? 0) * 1_000_000_000,
        ),
      };
    }
    LOG.warn(
      { mint: params.tokenMint.slice(0, 8), reason: nativeResult.reason },
      "Native sell attempt failed — falling back to Jupiter for this sell",
    );
    return jupiterSell(params, nativeResult.reason);
  } catch (err: any) {
    LOG.warn(
      { mint: params.tokenMint.slice(0, 8), err: err?.message },
      "Native sell attempt threw — falling back to Jupiter for this sell",
    );
    return jupiterSell(params, err?.message);
  }
}

/**
 * The single guarded entry point for every sell attempt. Acquires the
 * position-exit lease BEFORE deciding native vs Jupiter, so the guard
 * covers both paths — this is the fix for the placement bug described in
 * this file's header comment. Returns `route: "skipped"` (not a thrown
 * error) when a sell for this exact (wallet, mint) is already in flight;
 * callers should treat that the same as "nothing to do this tick," not as
 * a failure worth alerting on.
 */
export async function routeSell(
  params: SellRouteParams,
): Promise<SellRouteResult> {
  const claimed = await positionExitCoordinator.claimPositionExit(
    params.tokenMint,
    params.wallet,
  );
  if (!claimed) {
    return {
      route: "skipped",
      success: false,
      solLamportsOut: 0,
      error: "Sell already in flight for this wallet/position",
    };
  }

  try {
    const result = await attemptSell(params);
    if (result.success) {
      await positionExitCoordinator.completePositionExit(
        params.tokenMint,
        params.wallet,
      );
    } else {
      // Released, not completed — see cpmm.ts's earlier (now removed)
      // comment on this same trade-off, still true here: release-always on
      // failure means the very next monitor tick can retry immediately.
      // Whether that's the right cooldown behavior for every failure mode
      // is exactly what monitor.service.ts's own existing
      // isSellInBackoffCooldown()/recordSellFailure() already governs at a
      // higher level — this guard is only about preventing two attempts
      // from overlapping, not about pacing retries.
      await positionExitCoordinator.releasePositionExit(
        params.tokenMint,
        params.wallet,
      );
    }
    return result;
  } catch (err) {
    await positionExitCoordinator.releasePositionExit(
      params.tokenMint,
      params.wallet,
    );
    throw err;
  }
}

export default { routeSell };
