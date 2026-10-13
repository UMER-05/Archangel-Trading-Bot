// backend/src/services/multiUserExecution.service.ts
//
// Implements Phases 5–6 (Jupiter quote + trading) of the candidate pipeline
// (see candidatePipeline.service.ts) on a per-user custodial basis: once a
// token has cleared Phase 3 (Jupiter tradeability) and Phase 4 (ArchAngel
// filtering) exactly once, globally, this fans the buy decision out across
// every eligible funded, auto-trade-enabled user — each one independently
// risk-checked and executed with their OWN hot wallet (see userWallet.service.ts)
// — instead of a single admin wallet deciding once for everyone. The token-
// intrinsic checks (liquidity, routing, authority, market health) never get
// re-run here; what genuinely differs per user is balance, existing
// positions, and settings, all of which validationPipeline.service.ts's
// runPipeline() re-checks per WalletContext passed to it.
import { getLogger } from "../utils/logger.js";
import validationPipelineService, {
  WalletContext,
  PipelineResult,
} from "./validationPipeline.service.js";
import userWalletService from "./userWallet.service.js";
import {
  getEffectiveConfig,
  getEffectiveLaunchWindowSeconds,
  getTraderConfig,
} from "./traderConfig.service.js";
import { loadKeypairFromEnv } from "./solana.service.js";
import dbService from "./db.service.js";
import { withWalletLock } from "../utils/walletMutex.js";

const LOG = getLogger("multi-user-execution");

// Below this, a hot wallet is treated as unfunded for auto-trading purposes
// (matches validationPipeline.service.ts's own MIN_AUTO_TRADE_SOL floor —
// no point fanning a pipeline run out to a wallet that Stage 0 will reject
// anyway, that's just wasted Jupiter/Birdeye calls).
const MIN_FUNDED_BALANCE_SOL = Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.003);

const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

export interface LaunchMetrics {
  marketCapSOL: number;
}

export function launchMetricsWithinLimits(
  metrics: LaunchMetrics,
  config: Pick<
    Awaited<ReturnType<typeof getEffectiveConfig>>,
    "minMarketCapSol"
  >,
): boolean {
  return (
    Number.isFinite(metrics.marketCapSOL) &&
    metrics.marketCapSOL >= config.minMarketCapSol
  );
}

export function launchMetricsFromTokenState(
  state: Awaited<ReturnType<typeof dbService.getTokenState>>,
): LaunchMetrics | null {
  if (!state) return null;
  return {
    marketCapSOL: Number(state.launchMarketCapSOL),
  };
}

export function launchAgeWithinWindow(
  poolCreatedAt: Date | string | undefined,
  now: number,
  minSecondsSinceLaunch: number,
): boolean {
  if (!poolCreatedAt) return false;
  const createdAt = new Date(poolCreatedAt).getTime();
  if (!Number.isFinite(createdAt)) return false;
  const ageSeconds = (now - createdAt) / 1000;
  return ageSeconds >= minSecondsSinceLaunch;
}

function operatorWalletContext(): WalletContext {
  const keypair = loadKeypairFromEnv();
  const publicKey = keypair.publicKey.toBase58();
  return { ownerWallet: publicKey, publicKey, keypair };
}

/**
 * True unless this wallet has set its own Max Total Trades and already hit
 * it. No setting (the default for every wallet, including one that's never
 * touched Global Trade Settings) means unlimited — matches how every other
 * per-wallet setting in this codebase defaults to "off"/unrestricted until
 * explicitly configured.
 */
async function isUnderTradeCap(wallet: string): Promise<boolean> {
  const config = await getTraderConfig(wallet);
  const maxTotalTrades = config?.globalSettings?.maxTotalTrades;
  if (maxTotalTrades == null || maxTotalTrades <= 0) return true;
  const tradesTaken = await dbService.getTotalTradesCount(wallet);
  return tradesTaken < maxTotalTrades;
}

/**
 * Whether this wallet's own Global Trade Settings currently allow auto-buy —
 * meant to be re-read fresh right before a specific buy actually fires, not
 * just once when a whole fan-out batch's eligible list was built. Without
 * this second check, "Stop Auto Trade" disabling the flag mid-fan-out
 * wouldn't stop a buy for a wallet that was already in this run's eligible
 * list before the flag flipped — see the per-wallet re-check in
 * runPipelineForAllEligibleWallets below.
 *
 * The operator defaults to enabled (unchanged from before this flag existed,
 * so nobody who's never touched Global Trade Settings sees a behavior
 * change) — only an explicit false (from Stop Auto Trade) turns it off. A
 * regular user wallet defaults to disabled, same as getEligibleWallets()
 * below.
 */
export async function isAutoTradeCurrentlyEnabled(
  ownerWallet: string,
): Promise<boolean> {
  const config = await getTraderConfig(ownerWallet);
  if (ownerWallet === OPERATOR_WALLET) {
    return config?.globalSettings?.autoTradeEnabled !== false;
  }
  return config?.globalSettings?.autoTradeEnabled === true;
}

/**
 * Every wallet currently eligible to receive an auto-buy: the operator's
 * own wallet (the bot's original, always-on identity — gated the same way
 * it always has been, by JUPITER_AUTO_BUY/config upstream of this call) plus
 * every user-created custodial hot wallet that has auto-trade enabled in
 * its owner's Global Trade Settings AND a non-dust balance. Either can be
 * excluded by its own Max Total Trades cap, once reached, or by Stop Auto
 * Trade having explicitly disabled it.
 */
export async function getEligibleWallets(): Promise<WalletContext[]> {
  const eligible: WalletContext[] = [];
  if (!(await dbService.getGlobalAutoTradeEnabled())) {
    LOG.warn("Global auto-trade is paused; no wallets are eligible");
    return eligible;
  }

  // Operator wallet: eligible from this function's point of view unless it
  // has explicitly disabled auto-trade (Stop Auto Trade) or hit its own Max
  // Total Trades cap — whether auto-buy actually happens for it is also
  // still gated by the caller's own JUPITER_AUTO_BUY config, same as before
  // this phase existed.
  // A missing or malformed operator key (WALLET_SECRET_KEY / WALLET_PRIVATE_KEY)
  // must only exclude the operator wallet. Thrown out of here, it aborted the
  // whole fan-out, so no user hot wallet — each with its own key — could
  // ever be bought for either.
  let operatorCtx: WalletContext | null = null;
  try {
    operatorCtx = operatorWalletContext();
  } catch (err: any) {
    LOG.error(
      { err: err?.message },
      "Operator wallet key missing or invalid — operator wallet excluded; user wallets are still evaluated",
    );
  }
  if (operatorCtx) {
    if (
      (await isAutoTradeCurrentlyEnabled(operatorCtx.ownerWallet)) &&
      (await isUnderTradeCap(operatorCtx.ownerWallet))
    ) {
      eligible.push(operatorCtx);
    } else {
      LOG.info(
        { wallet: operatorCtx.ownerWallet },
        "Operator wallet excluded from this round: auto-trade disabled or Max Total Trades reached",
      );
    }
  }

  const userWallets = await userWalletService.listAllUserWallets();
  // Evaluated concurrently: each wallet costs a balance RPC read, a config
  // read and a key decrypt, and this ran for every wallet, one after another,
  // for every single candidate token — seconds added to each buy.
  const evaluated = await Promise.all(
    userWallets.map(async (uw): Promise<WalletContext | null> => {
      try {
        const config = await getTraderConfig(uw.ownerWallet);
        if (!config?.globalSettings?.autoTradeEnabled) return null;

        const { balanceSol } = (await userWalletService.getUserWalletBalanceSol(
          uw.ownerWallet,
        )) ?? { balanceSol: 0 };
        if (balanceSol < MIN_FUNDED_BALANCE_SOL) {
          // Was a silent skip: an auto-trade-enabled wallet whose hot wallet
          // has run dry looked, from the logs, identical to one skipped for
          // any other reason — or not evaluated at all.
          LOG.info(
            {
              ownerWallet: uw.ownerWallet,
              balanceSol,
              minFundedBalanceSol: MIN_FUNDED_BALANCE_SOL,
            },
            "Wallet excluded from this round: hot wallet below minimum funded balance",
          );
          return null;
        }

        const maxTotalTrades = config.globalSettings.maxTotalTrades;
        if (maxTotalTrades != null && maxTotalTrades > 0) {
          const tradesTaken = await dbService.getTotalTradesCount(uw.ownerWallet);
          if (tradesTaken >= maxTotalTrades) {
            LOG.info(
              { ownerWallet: uw.ownerWallet, tradesTaken, maxTotalTrades },
              "Wallet excluded from this round: Max Total Trades reached",
            );
            return null;
          }
        }

        const keypair = await userWalletService.getUserWalletKeypair(
          uw.ownerWallet,
        );
        if (!keypair) {
          LOG.warn(
            { ownerWallet: uw.ownerWallet },
            "Wallet excluded from this round: no signing key could be loaded for its hot wallet",
          );
          return null;
        }

        return {
          ownerWallet: uw.ownerWallet,
          publicKey: uw.hotWalletPublicKey,
          keypair,
        };
      } catch (err: any) {
        LOG.error(
          { ownerWallet: uw.ownerWallet, err: err?.message },
          "Failed to evaluate wallet for auto-trade eligibility — skipping it",
        );
        return null;
      }
    }),
  );
  for (const ctx of evaluated) if (ctx) eligible.push(ctx);

  return eligible;
}

export interface FanOutResult {
  ownerWallet: string;
  result: PipelineResult;
}

// Defaults to the existing Jupiter pipeline — see runPipelineForAllEligibleWallets's
// new third parameter below. Kept as a named type so executionRouter.service.ts's
// native call site has something concrete to match against.
type PipelineRunner = (
  tokenMint: string,
  lpSol: number,
  walletContext: WalletContext,
) => Promise<PipelineResult>;

/**
 * Runs the full validation+execution pipeline for a single token, once per
 * eligible wallet, sequentially. Sequential (not parallel) is deliberate: it
 * keeps Jupiter/Birdeye request pacing predictable rather than multiplying
 * bursts by however many users are active, and one wallet's slow/failed run
 * never risks stepping on another's in-flight buy. A failure or rejection
 * for one wallet never stops the rest — each is independent.
 *
 * `runPipelineFn` defaults to the Jupiter pipeline (validationPipelineService.runPipeline)
 * — unchanged behavior for every existing caller. executionRouter.service.ts's
 * native path passes a closure over validationPipelineService.runNativePipeline
 * instead, so eligibility checks (auto-trade enabled, market-cap window,
 * launch-age window), the per-wallet mutex, and position-metadata recording
 * below are shared verbatim between both execution methods rather than
 * duplicated — the only thing that actually differs per method is what
 * happens inside runPipelineFn itself.
 */
export async function runPipelineForAllEligibleWallets(
  tokenMint: string,
  lpSol: number,
  runPipelineFn: PipelineRunner = (mint, sol, ctx) =>
    validationPipelineService.runPipeline(mint, sol, ctx),
): Promise<FanOutResult[]> {
  const wallets = await getEligibleWallets();
  const results: FanOutResult[] = [];
  const launchMetrics = launchMetricsFromTokenState(
    await dbService.getTokenState(tokenMint),
  );

  for (const walletContext of wallets) {
    try {
      // Re-checked fresh right before this wallet's own execution, not just
      // trusted from the getEligibleWallets() snapshot above — closes the
      // window where Stop Auto Trade disables the flag after this batch's
      // list was built but before this specific wallet's turn came up.
      if (!(await isAutoTradeCurrentlyEnabled(walletContext.ownerWallet))) {
        LOG.info(
          { ownerWallet: walletContext.ownerWallet, tokenMint },
          "Skipping wallet: auto-trade was disabled after this run started",
        );
        results.push({
          ownerWallet: walletContext.ownerWallet,
          result: {
            success: false,
            reason: "Auto-trade disabled for this wallet",
            results: [],
          },
        });
        continue;
      }

      const config = await getEffectiveConfig(
        walletContext.ownerWallet,
        tokenMint,
      );
      // Both skips below are reported back as failed results (not just
      // logged) so the pipeline emits candidate:buy_failed and the trader's
      // dashboard says why nothing was bought. Reasons are kept free of
      // per-token numbers so the dashboard's once-a-minute dedupe holds.
      if (!launchMetrics || !launchMetricsWithinLimits(launchMetrics, config)) {
        LOG.info(
          { ownerWallet: walletContext.ownerWallet, tokenMint, launchMetrics },
          "Skipping wallet: launch market cap is below its configured minimum",
        );
        results.push({
          ownerWallet: walletContext.ownerWallet,
          result: {
            success: false,
            failedStage: 0,
            failedStageName: "Minimum Market Cap",
            reason: launchMetrics
              ? `Launch market cap is below your ${config.minMarketCapSol} SOL minimum`
              : "Launch market cap could not be determined",
            results: [],
          },
        });
        continue;
      }

      const launchWindow = await getEffectiveLaunchWindowSeconds(
        walletContext.ownerWallet,
      );
      if (
        !launchAgeWithinWindow(
          (await dbService.getTokenState(tokenMint))?.poolCreatedAt,
          Date.now(),
          launchWindow,
        )
      ) {
        LOG.info(
          { ownerWallet: walletContext.ownerWallet, tokenMint, launchWindow },
          "Skipping wallet: token is outside its configured launch window",
        );
        results.push({
          ownerWallet: walletContext.ownerWallet,
          result: {
            success: false,
            failedStage: 0,
            failedStageName: "Minimum Launch Age",
            reason: `Token was younger than your ${launchWindow}s minimum age when discovered — it is not re-checked later`,
            results: [],
          },
        });
        continue;
      }

      // Serialized per wallet (see walletMutex.ts) — this pipeline sizes
      // each buy from the wallet's live balance and its count of open
      // positions (utils/positionSizing.ts), so a wallet with a buy already
      // in flight (for a different candidate mint) must not have a second one
      // read the same stale balance/count concurrently. This one waits its
      // turn and sizes against what's actually left afterward — which is what
      // makes the "balance / free slots" split come out even.
      const result = await withWalletLock(
        walletContext.ownerWallet,
        async () => {
          const r = await runPipelineFn(tokenMint, lpSol, walletContext);
          // The position's metadata is written INSIDE the lock, before the next
          // queued buy sizes itself. remainingPct is what marks a position open
          // (utils/positionState.ts): written after the lock was released, a
          // re-bought token still carried its old "closed" marker for a moment
          // and the next buy didn't count it — one position too many.
          if (r.success && r.executionResult) {
            await dbService.updatePositionMetadata(
              tokenMint,
              walletContext.ownerWallet,
              {
                tpPct: config.takeProfitPct,
                slPct: config.stopLossPct,
                firstTrancheEntry: Date.now(),
                remainingPct: 100,
              },
            );
          }
          return r;
        },
      );
      results.push({ ownerWallet: walletContext.ownerWallet, result });
    } catch (err: any) {
      LOG.error(
        {
          ownerWallet: walletContext.ownerWallet,
          tokenMint,
          err: err?.message,
        },
        "Pipeline run failed unexpectedly for this wallet — continuing with the rest",
      );
      results.push({
        ownerWallet: walletContext.ownerWallet,
        result: {
          success: false,
          reason: err?.message || "Unexpected pipeline error",
          results: [],
        },
      });
    }
  }

  return results;
}

export default {
  getEligibleWallets,
  runPipelineForAllEligibleWallets,
  isAutoTradeCurrentlyEnabled,
};
