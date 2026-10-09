// backend/src/services/candidatePipeline.service.ts
//
// The single linear discovery→validate→buy pipeline. Replaces the three
// overlapping polling loops (jupiterDiscovery.service.ts,
// tokenDiscovery.service.ts + autoBuyer.service.ts, and
// storedTokenChecker.service.ts) that used to each run their own take on
// "Jupiter validation + filtering" concurrently. There is now exactly one
// entry point — processCandidateMint() — invoked once per mint, driven by
// the Solami Blur pool_create stream (see blurStream.service.ts) instead of
// three independent polling timers:
//
//   Phase 1  Blur pool_create stream  → blurStream.service.ts
//   Phase 2  Candidate extraction     → blurExtraction.service.ts
//   Phase 3  Jupiter validation       → jupiterTradeability.service.ts
//   Phase 4  Token filtering          → tokenFiltering.service.ts (mint/freeze
//                                        authority, buy/sell tax, honeypot,
//                                        creator/top-3 holdings — no Birdeye)
//   Phase 5  Jupiter quote  ┐          per-wallet fan-out → multiUserExecution.service.ts
//   Phase 6  Trading        ┘          (which calls validationPipeline.service.ts per
//                                        wallet, including a fresh pre-execution Jupiter
//                                        check — route/liquidity/impact/output/quote
//                                        freshness — immediately before each buy)
//   Phase 7  Monitoring               → monitor.service.ts / pnlTracker.service.ts
import { Server as SocketIOServer } from "socket.io";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { checkJupiterTradeability } from "./jupiterTradeability.service.js";
import {
  applyArchAngelFilters,
  ArchAngelFilterConfig,
} from "./tokenFiltering.service.js";
import executionRouterService from "./execution/executionRouter.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import {
  claimMint,
  completeMint,
  releaseMint,
} from "./discoveryCoordinator.service.js";
import type { CandidateMint } from "./tokenExtraction.service.js";

const LOG = getLogger("candidate-pipeline");

interface PipelineConfig extends ArchAngelFilterConfig {
  autoBuyEnabled: boolean;
}

function loadConfig(): PipelineConfig {
  return {
    maxBuyTax: Number(process.env.MAX_BUY_TAX_PCT || 5),
    maxSellTax: Number(process.env.MAX_SELL_TAX_PCT || 5),
    requireMintDisabled: process.env.REQUIRE_MINT_DISABLED !== "false",
    requireFreezeDisabled: process.env.REQUIRE_FREEZE_DISABLED !== "false",
    requireLpLocked: process.env.REQUIRE_LP_LOCKED === "true",
    autoBuyEnabled: process.env.JUPITER_AUTO_BUY === "true",
  };
}

let io: SocketIOServer | null = null;
export function setSocketIO(server: SocketIOServer): void {
  io = server;
}

// How stale a webhook delivery can be, measured from the pool's own
// on-chain creation time (tokenExtraction.service.ts now guarantees this is
// always present — see its own header comment), before this pipeline treats
// it as not worth acting on. A pool-creation event that's already several
// minutes old by the time it reaches us — a delayed/backlogged QuickNode
// delivery, a retried delivery, a replayed event — is one every other
// sniper bot on the network has had that same head start on; auto-buying it
// this late isn't "early discovery," it's just late. A negative age (a
// timestamp in the future) is rejected too — that's clock skew or a
// malformed payload, not a legitimately fresher event.
const MAX_CANDIDATE_DELIVERY_AGE_MS = 120_000; // 2 minutes

export function isFreshCandidate(
  poolCreatedAt: Date,
  now: number = Date.now(),
): boolean {
  const ageMs = now - poolCreatedAt.getTime();
  return ageMs >= 0 && ageMs <= MAX_CANDIDATE_DELIVERY_AGE_MS;
}

/**
 * Runs the full pipeline for a single candidate mint. Safe to call
 * concurrently for different mints; a given mint is only ever taken through
 * to a buy attempt once (see the claimMint/completeMint/releaseMint dedup
 * around Phase 5/6 below) — a duplicate webhook delivery for the same mint
 * is the expected reason to call this twice, not a bug.
 */
export async function processCandidateMint(
  candidate: CandidateMint,
  source: "blur" = "blur",
): Promise<void> {
  const { mint } = candidate;
  const config = loadConfig();

  // Already seen this mint before (regardless of outcome) — one pass through
  // this pipeline per mint is the whole point of the consolidation, so don't
  // reprocess it just because a second pool-creation event referenced it.
  const existing = await dbService.getTokenState(mint);
  if (existing) {
    LOG.debug(
      { mint: mint.slice(0, 8), state: existing.state },
      "Already processed — skipping",
    );
    return;
  }

  // Reject stale/delayed/future-dated deliveries before writing anything at
  // all — see isFreshCandidate's own doc comment for why. This intentionally
  // runs before the dedup write below: a stale delivery for a mint we've
  // never seen isn't worth recording in TokenState at all, not even as a
  // rejected candidate.
  if (!isFreshCandidate(candidate.poolCreatedAt)) {
    const ageMs = Date.now() - candidate.poolCreatedAt.getTime();
    LOG.info(
      {
        mint: mint.slice(0, 8),
        ageMs,
        poolCreatedAt: candidate.poolCreatedAt.toISOString(),
      },
      "❌ Candidate delivery too stale — skipping",
    );
    io?.emit("candidate:stale", { mint, ageMs });
    return;
  }

  LOG.info(
    { mint: mint.slice(0, 8), dex: candidate.dex, source },
    "🎯 New candidate discovered",
  );

  await dbService.upsertTokenState({
    mint,
    symbol: "UNKNOWN",
    name: "Unknown Token",
    state: "DISCOVERED",
    source,
    poolCreatedAt: candidate.poolCreatedAt,
    poolAddress: candidate.poolAddress,
    dex: candidate.dex,
    detectedAt: new Date(),
  });
  io?.emit("candidate:detected", {
    mint,
    dex: candidate.dex,
    source,
    timestamp: new Date().toISOString(),
  });

  // Phase 3 — Jupiter validation.
  const tradeability = await checkJupiterTradeability(mint);
  await dbService.upsertTokenState({
    mint,
    symbol: "UNKNOWN",
    name: "Unknown Token",
    state: tradeability.tradeable ? "TRADABLE" : "DISCOVERED",
    source,
    jupiterTradable: tradeability.tradeable,
    liquiditySOL: tradeability.liquiditySol,
    liquidityUSD: tradeability.liquidityUsd,
    poolCreatedAt: candidate.poolCreatedAt,
    poolAddress: candidate.poolAddress,
    dex: candidate.dex,
    detectedAt: new Date(),
    ...(tradeability.tradeable ? { confirmedTradableAt: new Date() } : {}),
  });
  // launchMarketCapSOL specifically goes through this targeted conditional
  // setter, not the upsertTokenState call above — see
  // setLaunchMarketCapIfUnset's own doc comment: by the time buyQuote data
  // exists to compute this from, the row itself was already created by the
  // very first "DISCOVERED" write earlier in this function, so
  // upsertTokenState's $setOnInsert handling of this field would silently
  // never apply here no matter which later call included it.
  //
  // The value itself comes straight from checkJupiterTradeability's own
  // result — it's already computed on-chain there (Phase 3's buy quote +
  // one mint-account read), so this must NOT be recomputed here. An earlier
  // version of this file did recompute it locally, which meant every single
  // candidate did two independent getOnChainMintSupply RPC calls for the
  // exact same number.
  if (tradeability.launchMarketCapSol != null) {
    await dbService.setLaunchMarketCapIfUnset(
      mint,
      tradeability.launchMarketCapSol,
    );
  }

  if (!tradeability.tradeable) {
    LOG.info(
      { mint: mint.slice(0, 8), reason: tradeability.reason },
      "❌ Not tradeable on Jupiter",
    );
    io?.emit("candidate:not_tradeable", { mint, reason: tradeability.reason });
    return;
  }
  io?.emit("candidate:tradeable", {
    mint,
    liquiditySol: tradeability.liquiditySol,
  });

  // Phase 4 — token filtering (ArchAngel criteria).
  const filterResult = await applyArchAngelFilters(
    mint,
    config,
    candidate.poolAddress,
  );
  // Exposed via GET /api/tokens/active and GET /api/tokens/approved-candidates
  // (tokens.route.ts) — a normal $set on every call, correct whether this
  // mint's row already exists or not (unlike launchMarketCapSOL above, this
  // has no "first write wins" requirement: it's always this candidate's one
  // and only Phase 4 result).
  await dbService.upsertTokenState({
    mint,
    symbol: "UNKNOWN",
    name: "Unknown Token",
    state: "TRADABLE",
    source,
    detectedAt: new Date(),
    autoBuyEligible: filterResult.approved,
  });
  if (!filterResult.approved) {
    LOG.info(
      { mint: mint.slice(0, 8), failed: filterResult.failedFilters },
      `❌ ${filterResult.reason}`,
    );
    io?.emit("candidate:filtered_out", {
      mint,
      reason: filterResult.reason,
      failedFilters: filterResult.failedFilters,
    });
    return;
  }
  LOG.info(
    { mint: mint.slice(0, 8), passed: filterResult.passedFilters },
    "✅ Passed ArchAngel filters",
  );
  io?.emit("candidate:approved", {
    mint,
    passedFilters: filterResult.passedFilters,
  });

  if (!config.autoBuyEnabled) {
    LOG.debug(
      { mint: mint.slice(0, 8) },
      "Auto-buy disabled — stopping after filtering",
    );
    return;
  }

  // Claim before Phase 5/6: prevents a duplicate/near-simultaneous webhook
  // delivery for the same mint from triggering two independent buy fan-outs.
  if (!(await claimMint(mint))) {
    LOG.debug(
      { mint: mint.slice(0, 8) },
      "Mint already claimed for buy — skipping",
    );
    return;
  }

  LOG.info(
    { mint: mint.slice(0, 8) },
    "🚀 Phase 5/6 — quoting and buying across eligible wallets",
  );
  // Routed through executionRouter.service.ts rather than calling
  // multiUserExecutionService directly — the router is what decides
  // per-candidate whether this goes through a Raydium-native executor
  // (feature-flagged, defaults off) or the existing Jupiter path. With no
  // native executors registered yet, this is behaviorally identical to the
  // direct call it replaces.
  let fanOutResults;
  try {
    const routed = await executionRouterService.routeExecution(
      candidate,
      tradeability.liquiditySol,
    );
    fanOutResults = routed.fanOutResults;
    if (routed.route === "jupiter" && routed.nativeFallbackReason) {
      LOG.info(
        { mint: mint.slice(0, 8), reason: routed.nativeFallbackReason },
        "Fell back to Jupiter after a native execution attempt",
      );
    }
  } catch (err) {
    await releaseMint(mint);
    throw err;
  }
  await completeMint(mint);

  // Phase 7 — hand off to monitoring for every wallet that actually bought.
  for (const { ownerWallet, result } of fanOutResults) {
    if (!result.success) {
      LOG.warn(
        { mint: mint.slice(0, 8), wallet: ownerWallet, reason: result.reason },
        `❌ Buy failed at stage ${result.failedStage}: ${result.failedStageName}`,
      );
      emitToWalletOrGlobal(io, ownerWallet, "candidate:buy_failed", {
        mint,
        wallet: ownerWallet,
        failedStage: result.failedStage,
        failedStageName: result.failedStageName,
        reason: result.reason,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    LOG.info(
      {
        mint: mint.slice(0, 8),
        wallet: ownerWallet,
        signature: result.executionResult?.signature,
      },
      "✅ Buy executed — handing off to monitoring",
    );

    if (result.executionResult) {
      pnlTrackerService.startTracking({
        tokenMint: mint,
        entryPrice: result.executionResult.actualPrice || 0,
        amount: result.executionResult.tokensReceived || 0,
        wallet: ownerWallet,
        entryTime: Date.now(),
      });
    }

    emitToWalletOrGlobal(io, ownerWallet, "tradeFeed", {
      type: "buy",
      token: mint,
      wallet: ownerWallet,
      amount: Math.round((result.executionResult?.amountSol ?? 0) * 1e9),
      price: result.executionResult?.actualPrice,
      pnl: 0,
      signature: result.executionResult?.signature,
      timestamp: new Date().toISOString(),
      auto: true,
      reason: "candidate_pipeline_buy",
      route: "jupiter",
    });

    emitToWalletOrGlobal(io, ownerWallet, "candidate:buy_success", {
      mint,
      wallet: ownerWallet,
      signature: result.executionResult?.signature,
      tokensReceived: result.executionResult?.tokensReceived,
      actualPrice: result.executionResult?.actualPrice,
      timestamp: new Date().toISOString(),
    });
  }
}

export default { setSocketIO, processCandidateMint, isFreshCandidate };
