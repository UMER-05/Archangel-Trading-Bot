import { getLogger } from "../utils/logger.js";
import {
  getJupiterQuote,
  executeJupiterSwap,
  type JupiterQuote,
} from "./jupiter.service.js";
import {
  hasSufficientBalance,
  getConnection,
  getBalanceInSol,
  loadKeypairFromEnv,
} from "./solana.service.js";
import { PublicKey, Keypair } from "@solana/web3.js";
import dbService from "./db.service.js";
import { canExecuteTrade } from "./riskManagement.service.js";
import { getEffectiveConfig, getTraderConfig } from "./traderConfig.service.js";
import { computePositionSize, sizingEnv } from "../utils/positionSizing.js";

/**
 * Identifies which wallet a pipeline run buys/sells for — the custodial
 * hot wallet belonging to a specific connected user, not always the single
 * admin wallet. ownerWallet is the *connected* (Phantom/Solflare) wallet
 * this hot wallet belongs to, used for risk/settings lookups; publicKey and
 * keypair are the hot wallet that actually holds funds and signs.
 */
export interface WalletContext {
  ownerWallet: string;
  publicKey: string;
  keypair: Keypair;
}

function defaultWalletContext(): WalletContext {
  const keypair = loadKeypairFromEnv();
  const publicKey = keypair.publicKey.toBase58();
  return { ownerWallet: publicKey, publicKey, keypair };
}

const LOG = getLogger("validation-pipeline");
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface ExecutionResult {
  success: boolean;
  signature?: string;
  tokensReceived?: number;
  actualPrice?: number;
  amountSol?: number;
  error?: string;
}

interface ValidationResult {
  passed: boolean;
  stage: number;
  stageName: string;
  reason?: string;
  details?: any;
}

interface PipelineResult {
  success: boolean;
  failedStage?: number;
  failedStageName?: string;
  reason?: string;
  results: ValidationResult[];
  executionResult?: ExecutionResult;
}

class ValidationPipelineService {
  // Was a bare literal with no override, unlike every sibling threshold in
  // this class. Default kept the same (49%) to avoid silently changing
  // trading behavior — this just makes it tunable.
  private readonly MAX_SLIPPAGE = Number(
    process.env.MAX_PIPELINE_SLIPPAGE_PCT ?? 49,
  );
  // Used by the "liquidity sufficient?" Jupiter execution check — see
  // evaluateJupiterExecutionQuote. Deliberately independent of Phase 3's own
  // liquidity floor (jupiterTradeability.service.ts): that one ran once,
  // possibly seconds to minutes ago; this one re-checks right before
  // spending real capital.
  private readonly MIN_EXECUTION_LIQUIDITY_SOL = Number(
    process.env.MIN_EXECUTION_LIQUIDITY_SOL ?? 1,
  );
  // Used by the "quote still valid?" Jupiter execution check.
  private readonly MAX_QUOTE_AGE_MS = Number(
    process.env.MAX_QUOTE_AGE_MS ?? 8000,
  );
  /**
   * Per-wallet execution leg of the single linear discovery→validate→buy
   * pipeline (see candidatePipeline.service.ts for the full sequence).
   *
   * Token-intrinsic checks — is it tradeable on Jupiter (Phase 3), and does
   * it pass ArchAngel's filters: tax, mint/freeze authority, LP lock, holder
   * concentration, liquidity/volume/price health (Phase 4) — already ran
   * exactly ONCE for this mint, globally, before any wallet gets here. This
   * function no longer re-derives any of that; re-checking it per wallet was
   * the exact duplicated work called out in the pre-refactor pipeline audit.
   *
   * What genuinely differs per wallet is handled here: position sizing
   * against that wallet's live balance and risk limits (Stage 0), a final
   * quote sized to that wallet's own buy amount (Stage 1 — Phase 5, done
   * per-wallet because the buy amount is per-wallet), and the actual buy
   * (Stage 2 — Phase 6).
   */
  async runPipeline(
    tokenMint: string,
    lpSol: number,
    walletContext: WalletContext = defaultWalletContext(),
  ): Promise<PipelineResult> {
    LOG.info(
      { wallet: walletContext.ownerWallet },
      `🚀 Starting per-wallet execution for ${tokenMint.slice(0, 8)}...`,
    );

    const results: ValidationResult[] = [];

    // Stage 0 is execution-method-agnostic (balance/risk sizing doesn't care
    // whether the buy that follows goes through Jupiter or a native
    // executor) — see sizePositionAndCheckRisk, shared with
    // runNativePipeline below rather than duplicated.
    const stage0 = await this.sizePositionAndCheckRisk(
      tokenMint,
      walletContext,
    );
    if (!stage0.passed) {
      results.push(stage0.result);
      await this.logFailure(
        tokenMint,
        0,
        stage0.result.stageName,
        stage0.result.reason || "Unknown",
      );
      return this.buildFailureResult(
        0,
        stage0.result.stageName,
        stage0.result.reason,
        results,
      );
    }
    const buySol = stage0.buySol;
    const wallet = walletContext.publicKey;
    const { slippageBps, priorityFeeSol } = stage0;

    // Stage 1 (Phase 5 — Jupiter quote): fresh, per-wallet-sized quote +
    // affordability check right before committing capital.
    const stage1 = await this.stage1_preExecutionCheck(
      tokenMint,
      buySol,
      wallet,
      slippageBps,
    );
    results.push(stage1);
    if (!stage1.passed) {
      await this.logFailure(
        tokenMint,
        1,
        "Jupiter Pre-Execution",
        stage1.reason || "Unknown",
      );
      return this.buildFailureResult(
        1,
        "Jupiter Pre-Execution",
        stage1.reason,
        results,
      );
    }

    // Stage 2 (Phase 6 — Trading): execute the swap.
    const stage2 = await this.stage2_buyExecution(
      tokenMint,
      buySol,
      walletContext,
      slippageBps,
      priorityFeeSol,
    );
    results.push(stage2);
    if (!stage2.passed) {
      await this.logFailure(
        tokenMint,
        2,
        "Jupiter Buy Execution",
        stage2.reason || "Unknown",
      );
      return this.buildFailureResult(
        2,
        "Jupiter Buy Execution",
        stage2.reason,
        results,
      );
    }

    LOG.info(`✅ Execution PASSED for ${tokenMint.slice(0, 8)}`);

    return {
      success: true,
      results,
      executionResult: stage2.details?.executionResult,
    };
  }

  /**
   * Native-execution counterpart to runPipeline() — same Stage 0 sizing
   * and risk gating (reused, not duplicated), but the actual buy is
   * delegated to `executeNative` instead of Jupiter. That indirection is
   * deliberate: this file has no business importing a specific DEX
   * executor (cpmm.ts, or a future ammV4.ts/clmm.ts) — the caller
   * (executionRouter.service.ts, which already knows which executor and
   * candidate it's routing to) supplies the actual buy as a callback.
   *
   * There is no per-wallet "pre-execution quote check" analogous to
   * Jupiter's Stage 1 here — the native executor's own pool verification
   * (poolVerification.service.ts, re-checked inside buy() regardless of
   * whether the router already did it) and on-chain minimumAmountOut
   * guard already are that check, just structured differently than a
   * quote-then-execute split. Folding them into a separate synthetic
   * "Stage 1" here would be re-implementing logic that already lives
   * correctly in cpmm.ts, not adding a new safety layer.
   */
  async runNativePipeline(
    tokenMint: string,
    walletContext: WalletContext,
    executeNative: (
      buySol: number,
      ctx: { ownerWallet: string; keypair: Keypair },
    ) => Promise<{
      success: boolean;
      signature?: string;
      tokensReceived?: number;
      reason?: string;
    }>,
    routeLabel: "raydium-cpmm" | "raydium-amm-v4" | "raydium-clmm",
  ): Promise<PipelineResult> {
    LOG.info(
      { wallet: walletContext.ownerWallet, route: routeLabel },
      `🚀 Starting native per-wallet execution for ${tokenMint.slice(0, 8)}...`,
    );

    const results: ValidationResult[] = [];

    const stage0 = await this.sizePositionAndCheckRisk(
      tokenMint,
      walletContext,
    );
    if (!stage0.passed) {
      results.push(stage0.result);
      await this.logFailure(
        tokenMint,
        0,
        stage0.result.stageName,
        stage0.result.reason || "Unknown",
      );
      return this.buildFailureResult(
        0,
        stage0.result.stageName,
        stage0.result.reason,
        results,
      );
    }
    const buySol = stage0.buySol;

    try {
      const nativeResult = await executeNative(buySol, {
        ownerWallet: walletContext.ownerWallet,
        keypair: walletContext.keypair,
      });

      if (!nativeResult.success) {
        const stage1: ValidationResult = {
          passed: false,
          stage: 1,
          stageName: `${routeLabel} Buy Execution`,
          reason: nativeResult.reason || "Native execution failed",
        };
        results.push(stage1);
        await this.logFailure(
          tokenMint,
          1,
          stage1.stageName,
          stage1.reason || "Unknown",
        );
        return this.buildFailureResult(
          1,
          stage1.stageName,
          stage1.reason,
          results,
        );
      }

      // Same decimals-lookup approach as Jupiter's Stage 2, and the same
      // reason: nativeResult.tokensReceived is in raw base units (see
      // cpmm.ts's buy(), which mirrors Jupiter's outAmount convention
      // exactly for this reason), and a wrong decimals guess here
      // corrupts cost basis the same way it would for a Jupiter trade.
      let decimals: number | null = null;
      try {
        const info = await getConnection().getParsedAccountInfo(
          new PublicKey(tokenMint),
        );
        const d = (info.value?.data as any)?.parsed?.info?.decimals;
        if (typeof d === "number" && Number.isFinite(d)) decimals = d;
      } catch {
        // handled below
      }
      if (decimals === null) {
        LOG.error(
          { tokenMint },
          "Could not determine real token decimals — recording cost basis with an assumed value of 9, verify this trade manually",
        );
        decimals = 9;
      }
      const tokensReceived =
        (nativeResult.tokensReceived ?? 0) / 10 ** decimals;
      const actualPrice = tokensReceived > 0 ? buySol / tokensReceived : 0;

      const executionResult: ExecutionResult = {
        success: true,
        signature: nativeResult.signature ?? "",
        tokensReceived,
        actualPrice,
        amountSol: buySol,
      };

      const useReal = process.env.USE_REAL_SWAP === "true";
      await dbService.addTrade({
        type: "buy",
        token: tokenMint,
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: Math.floor(buySol * 1e9),
        price: actualPrice,
        pnl: 0,
        wallet: walletContext.ownerWallet,
        simulated: !useReal,
        signature: nativeResult.signature || "",
        route: routeLabel,
        custody: "custodial",
      });

      LOG.info(
        `✅ Native execution PASSED for ${tokenMint.slice(0, 8)} (${nativeResult.signature})`,
      );
      results.push({
        passed: true,
        stage: 1,
        stageName: `${routeLabel} Buy Execution`,
        details: { executionResult },
      });
      return { success: true, results, executionResult };
    } catch (error: any) {
      LOG.error(`❌ Native execution error: ${error.message}`);
      const reason = `Error: ${error.message}`;
      results.push({
        passed: false,
        stage: 1,
        stageName: `${routeLabel} Buy Execution`,
        reason,
      });
      return this.buildFailureResult(
        1,
        `${routeLabel} Buy Execution`,
        reason,
        results,
      );
    }
  }

  /**
   * Stage 0 — POSITION SIZING + RISK MANAGEMENT CHECK, shared by
   * runPipeline() (Jupiter) and runNativePipeline().
   *
   * The trader's "Max Open Positions" (N) says how many positions the bot
   * may hold at once, and the trading wallet's live balance is split across
   * the slots still free: buy = spendable balance / free slots (see
   * utils/positionSizing.ts for the rule and its edge cases). What stops the
   * bot opening another position is either every slot being in use or a low
   * balance — not a fixed SOL amount and not a percentage cap.
   *
   * Every eligible wallet's buy for a candidate mint funnels through one of
   * the two pipeline entry points, and each runs inside that wallet's lock
   * (utils/walletMutex.ts), so concurrent candidates size one after another
   * against a balance and open-position count that already include the
   * previous buy. This is the single place that guarantees sizing and the
   * MAX_OPEN_POSITIONS / MAX_DAILY_LOSS_PCT limits apply to every real buy,
   * regardless of execution method.
   */
  private async sizePositionAndCheckRisk(
    tokenMint: string,
    walletContext: WalletContext,
  ): Promise<
    | {
        passed: true;
        buySol: number;
        slippageBps: number;
        priorityFeeSol: number;
      }
    | { passed: false; result: ValidationResult }
  > {
    if (!(await dbService.getGlobalAutoTradeEnabled())) {
      return {
        passed: false,
        result: {
          passed: false,
          stage: 0,
          stageName: "Global Auto-Trade Pause",
          reason: "Global auto-buys are paused by the operator",
        },
      };
    }

    const wallet = walletContext.publicKey;
    const [walletBalance, config, openPositions] = await Promise.all([
      getBalanceInSol(wallet),
      getEffectiveConfig(walletContext.ownerWallet, tokenMint),
      dbService.getOpenPositionCount(walletContext.ownerWallet),
    ]);
    const { minTradeSol, feeReserveSol } = sizingEnv();

    // Max Total Trades — re-checked HERE, under the wallet lock. The fan-out
    // (multiUserExecution.getEligibleWallets) also checks it, but that runs
    // BEFORE the lock: when several candidates arrive together they all see
    // the same "trades so far", all pass, then buy one after another — which
    // is how a wallet capped at 2 ended up with more. Here each buy sees the
    // trades recorded by the ones before it.
    const traderConfig = await getTraderConfig(walletContext.ownerWallet);
    const maxTotalTrades = traderConfig?.globalSettings?.maxTotalTrades;
    if (maxTotalTrades != null && maxTotalTrades > 0) {
      const tradesTaken = await dbService.getTotalTradesCount(
        walletContext.ownerWallet,
      );
      if (tradesTaken >= maxTotalTrades) {
        return {
          passed: false,
          result: {
            passed: false,
            stage: 0,
            stageName: "Max Total Trades",
            reason: `Max Total Trades reached (${tradesTaken} of ${maxTotalTrades} used) — raise it in Trading Settings`,
            details: { tradesTaken, maxTotalTrades },
          },
        };
      }
    }

    // Trading budget: when set, the bot may only have this much at work, so
    // profits and anything deposited beyond it are never traded.
    const rawBudget = traderConfig?.globalSettings?.tradingBudgetSol;
    const budgetSol =
      typeof rawBudget === "number" && rawBudget > 0 ? rawBudget : null;
    const { deployedSol, realizedLossSol } =
      budgetSol !== null
        ? await dbService.getBudgetState(
            walletContext.ownerWallet,
            traderConfig?.globalSettings?.tradingBudgetSetAt ?? 0,
          )
        : { deployedSol: 0, realizedLossSol: 0 };

    const sizing = computePositionSize({
      balanceSol: walletBalance,
      openPositions,
      maxOpenPositions: config.maxOpenPositions,
      minTradeSol,
      feeReserveSol,
      budgetSol,
      deployedSol,
      realizedLossSol,
      fixedTradeAmountSol: config.fixedTradeAmountSol ?? undefined,
    });

    if (!sizing.ok) {
      const details = {
        walletBalance,
        openPositions,
        maxOpenPositions: config.maxOpenPositions,
        minTradeSol,
        feeReserveSol,
        budgetSol,
        deployedSol,
        realizedLossSol,
      };
      if (sizing.code === "AT_CAPACITY") {
        return {
          passed: false,
          result: {
            passed: false,
            stage: 0,
            stageName: "Max Open Positions",
            reason:
              `All ${sizing.maxOpenPositions} position slots are in use ` +
              `(${sizing.openPositions} open) — a new position opens when one closes`,
            details,
          },
        };
      }
      if (sizing.limitedBy === "budget") {
        // The wallet has cash, but the trader's budget has none left: it is
        // all at work in open positions (or the budget is below one position).
        return {
          passed: false,
          result: {
            passed: false,
            stage: 0,
            stageName: "Trading Budget",
            reason:
              `Trading budget used up: ${deployedSol.toFixed(4)} SOL is at work in open positions` +
              (realizedLossSol > 0
                ? ` and ${realizedLossSol.toFixed(4)} SOL of the ${budgetSol?.toFixed(4)} SOL budget has been lost`
                : ` of the ${budgetSol?.toFixed(4)} SOL budget`) +
              ` — the rest of the wallet is protected and won't be traded. ` +
              `A new position opens when one closes, or raise the budget` +
              (sizing.neededBudgetSol != null
                ? ` to at least ${sizing.neededBudgetSol.toFixed(3)} SOL`
                : ""),
            details,
          },
        };
      }
      return {
        passed: false,
        result: {
          passed: false,
          stage: 0,
          stageName: "Low Balance",
          reason:
            `Low balance: ${walletBalance.toFixed(4)} SOL, minus ` +
            `${feeReserveSol} SOL kept for fees, is under the ${minTradeSol} SOL ` +
            `minimum for a new position — top up to at least ` +
            `${sizing.neededSol.toFixed(3)} SOL`,
          details,
        },
      };
    }

    const buySol = sizing.buySol;

    const riskCheck = await canExecuteTrade(buySol, wallet, {
      ownerWallet: walletContext.ownerWallet,
      maxDailyLossPct: config.maxDailyLossPct,
      maxRiskPerTradePct: config.maxRiskPerTradePct,
      // Never for auto-buys (as before the fixed-size option existed): the
      // size is either the trader's 1/N split or the exact amount they typed
      // into "Fixed SOL per trade" — in both cases the amount IS their risk
      // decision. Enforcing the default 2%-of-equity cap on a fixed amount
      // refused almost any realistic size (0.1 SOL on a 1 SOL wallet) and
      // the bot silently never bought. The cap still applies to manual buys.
      enforcePerTradeCap: false,
    });
    if (!riskCheck.allowed) {
      return {
        passed: false,
        result: {
          passed: false,
          stage: 0,
          stageName: "Risk Management",
          reason: riskCheck.reason || "Risk limit exceeded",
          details: riskCheck.currentRisk,
        },
      };
    }

    return {
      passed: true,
      buySol,
      slippageBps: config.slippageBps,
      priorityFeeSol: config.priorityFeeSol,
    };
  }

  /**
   * STAGE 1 (Phase 5 — Jupiter quote): get a fresh quote sized to this
   * wallet's own buy amount and confirm it can actually afford the trade
   * right before committing capital. Kept per-wallet rather than folded into
   * the one-time global Phase 3/4 checks because the buy amount — and so the
   * quote itself — is different for every wallet.
   */
  /**
   * The five Jupiter execution checks, run twice per buy: once in Stage 1
   * (pre-execution, before touching balance checks or the wallet lock) and
   * again in Stage 2 on a BRAND NEW quote fetched immediately before the
   * swap itself. Running it twice against two different quotes is what
   * makes "quote still valid" a real check rather than a formality — a
   * pool can thin out or get partially drained in the seconds between
   * Stage 1 approving a candidate and Stage 2 actually executing (wallet
   * lock queueing, balance checks, other wallets' buys in the same
   * fan-out), and only re-validating a fresh quote at the last possible
   * moment catches that.
   *
   *   Jupiter
   *   ├── Buy route exists?
   *   ├── Liquidity sufficient?
   *   ├── Price impact acceptable?
   *   ├── Expected output acceptable?
   *   └── Quote still valid?
   */
  private evaluateJupiterExecutionQuote(
    quote: JupiterQuote | null,
    quoteFetchedAt: number,
  ): { passed: boolean; reason?: string; checks: Record<string, boolean> } {
    const checks: Record<string, boolean> = {
      buy_route_exists: false,
      liquidity_sufficient: false,
      price_impact_acceptable: false,
      expected_output_acceptable: false,
      quote_still_valid: false,
    };

    // 1. Buy route exists?
    if (!quote || !(quote.outAmount > 0)) {
      return {
        passed: false,
        reason: "No Jupiter buy route available",
        checks,
      };
    }
    checks.buy_route_exists = true;

    // 2. Liquidity sufficient? — same constant-product price-impact-implied
    // reserve estimate resolveLiquidityUsd uses (see jupiter.service.ts),
    // inlined here in pure SOL terms so this needs no USD conversion and no
    // third-party price feed. impact === 0 reads as "comfortably deep, no
    // measurable impact from this trade size" rather than "unknown."
    const impact = quote.priceImpactPct;
    const inSol = quote.inAmount / 1e9;
    let impliedLiquiditySol = Infinity;
    if (Number.isFinite(impact) && impact > 0) {
      impliedLiquiditySol = (2 * inSol) / impact;
    } else if (!Number.isFinite(impact) || impact < 0) {
      impliedLiquiditySol = 0; // can't read the impact at all — fail closed
    }
    if (impliedLiquiditySol < this.MIN_EXECUTION_LIQUIDITY_SOL) {
      return {
        passed: false,
        reason: `Implied liquidity too thin: ~${impliedLiquiditySol.toFixed(2)} SOL < ${this.MIN_EXECUTION_LIQUIDITY_SOL} SOL minimum`,
        checks,
      };
    }
    checks.liquidity_sufficient = true;

    // 3. Price impact acceptable?
    if (!Number.isFinite(impact) || impact > this.MAX_SLIPPAGE) {
      return {
        passed: false,
        reason: `Price impact too high: ${Number.isFinite(impact) ? impact.toFixed(2) : "unknown"}%`,
        checks,
      };
    }
    checks.price_impact_acceptable = true;

    // 4. Expected output acceptable? — Jupiter's own worst-case guaranteed
    // output (otherAmountThreshold) must exist and must not imply Jupiter
    // is itself budgeting for far more slippage than we configured; either
    // one is a sign something is wrong with this specific quote, not just
    // "the market moved."
    const guaranteedOut = quote.otherAmountThreshold;
    if (!(guaranteedOut > 0)) {
      return {
        passed: false,
        reason: "No guaranteed minimum output on quote",
        checks,
      };
    }
    const impliedWorstCaseSlippagePct =
      ((quote.outAmount - guaranteedOut) / quote.outAmount) * 100;
    const configuredSlippagePct = quote.slippageBps / 100;
    if (impliedWorstCaseSlippagePct > configuredSlippagePct * 2) {
      return {
        passed: false,
        reason: `Quote's guaranteed output implies ${impliedWorstCaseSlippagePct.toFixed(1)}% slippage, far above the ${configuredSlippagePct.toFixed(1)}% configured`,
        checks,
      };
    }
    checks.expected_output_acceptable = true;

    // 5. Quote still valid? — freshness. Jupiter quotes are only good for a
    // few seconds on a fast-moving pool; anything fetched further back than
    // this is stale enough that re-quoting is safer than trusting it.
    const ageMs = Date.now() - quoteFetchedAt;
    if (ageMs > this.MAX_QUOTE_AGE_MS) {
      return {
        passed: false,
        reason: `Quote is ${(ageMs / 1000).toFixed(1)}s old, exceeds ${this.MAX_QUOTE_AGE_MS / 1000}s freshness limit`,
        checks,
      };
    }
    checks.quote_still_valid = true;

    return { passed: true, checks };
  }

  private async stage1_preExecutionCheck(
    tokenMint: string,
    buySol: number,
    wallet: string,
    slippageBps: number,
  ): Promise<ValidationResult> {
    LOG.info(
      `[Stage 1] 🔍 Jupiter Pre-Execution Check for ${tokenMint.slice(0, 8)}...`,
    );

    try {
      const lamports = Math.floor(buySol * 1e9);

      const quote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        slippageBps,
      );
      const quoteFetchedAt = Date.now();

      const evaluation = this.evaluateJupiterExecutionQuote(
        quote,
        quoteFetchedAt,
      );
      if (!evaluation.passed) {
        return {
          passed: false,
          stage: 1,
          stageName: "Jupiter Pre-Execution",
          details: { checks: evaluation.checks, quote },
          // Under exactOptionalPropertyTypes, an optional field must be a
          // real value or entirely absent — evaluation.reason is typed
          // string | undefined, so assigning it directly is a type error
          // even though it's only ever actually undefined when passed=true
          // (which never reaches this branch). Conditional spread omits the
          // key outright instead.
          ...(evaluation.reason !== undefined && { reason: evaluation.reason }),
        };
      }

      if (process.env.USE_REAL_SWAP === "true") {
        // buySol was sized (Stage 0) from the balance MINUS a fee reserve, so
        // the fee margin is already held back. The default 5% buffer on top
        // would refuse the last free slot on any wallet above ~0.21 SOL
        // (balance < 1.05 x (balance - reserve)); 0 keeps this a plain
        // "is the money still there" check.
        const hasBalance = await hasSufficientBalance(wallet, buySol, 0);
        if (!hasBalance) {
          return {
            passed: false,
            stage: 1,
            stageName: "Jupiter Pre-Execution",
            reason: "Insufficient wallet balance for buy amount",
          };
        }
      }

      LOG.info(
        { checks: evaluation.checks },
        `[Stage 1] ✅ Jupiter Pre-Execution Check PASSED`,
      );
      return {
        passed: true,
        stage: 1,
        stageName: "Jupiter Pre-Execution",
        details: { checks: evaluation.checks, quote },
      };
    } catch (error: any) {
      LOG.error(`[Stage 1] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 1,
        stageName: "Jupiter Pre-Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  /**
   * STAGE 6: JUPITER EXECUTION (BUY)
   */
  private async stage2_buyExecution(
    tokenMint: string,
    buySol: number,
    walletContext: WalletContext,
    slippageBps: number,
    priorityFeeSol: number,
  ): Promise<ValidationResult> {
    const wallet = walletContext.publicKey;
    LOG.info(
      `[Stage 2] 🚀 Jupiter Buy Execution for ${tokenMint.slice(0, 8)}...`,
    );

    try {
      const lamports = Math.floor(buySol * 1e9);

      const quote = await getJupiterQuote(
        SOL_MINT,
        tokenMint,
        lamports,
        slippageBps,
      );
      const quoteFetchedAt = Date.now();

      // Re-run the same five checks Stage 1 did, against a BRAND NEW quote
      // fetched right now — this is what makes "quote still valid" mean
      // something: Stage 1 may have approved this buy seconds ago, before
      // the wallet lock queue or a balance check added latency, or before
      // another wallet in this same fan-out moved the pool. If the pool has
      // thinned out or the price has moved past what's acceptable since
      // then, this catches it immediately before capital actually moves —
      // not "does a route exist," the same full bar Stage 1 held it to.
      const evaluation = this.evaluateJupiterExecutionQuote(
        quote,
        quoteFetchedAt,
      );
      if (!evaluation.passed || !quote) {
        // The `!quote` half of this condition should be unreachable in
        // practice — evaluateJupiterExecutionQuote only reports passed=true
        // when its own internal quote check succeeded — but TypeScript
        // can't see that guarantee across the function boundary. Checking
        // it explicitly here (rather than a non-null assertion) is what
        // keeps `quote` narrowed to non-null for everything below.
        const reason =
          evaluation.reason ?? "Quote unexpectedly missing after evaluation";
        return {
          passed: false,
          stage: 2,
          stageName: "Jupiter Buy Execution",
          reason,
          details: { checks: evaluation.checks },
        };
      }

      const useReal = process.env.USE_REAL_SWAP === "true";
      const swapResult = useReal
        ? await executeJupiterSwap({
            inputMint: SOL_MINT,
            outputMint: tokenMint,
            amount: lamports,
            userPublicKey: wallet,
            slippageBps,
            signer: walletContext.keypair,
            priorityFeeSol,
          })
        : {
            success: true as const,
            signature: `sim-${Date.now()}`,
            simulated: true,
          };

      if (!swapResult.success) {
        return {
          passed: false,
          stage: 2,
          stageName: "Jupiter Buy Execution",
          reason: (swapResult as any).error || "Execution failed",
          details: swapResult,
        };
      }

      // outAmount is in the output token's base units — fetch its real decimals
      // rather than assuming 9 (many SPL tokens, e.g. BONK, use fewer).
      // Decimals feed directly into tokensReceived/actualPrice, which become
      // this position's recorded cost basis — a silent wrong guess here
      // corrupts every downstream PnL/TP/SL decision by the same factor.
      // Sourced on-chain, straight from the mint account — Jupiter's role in
      // this pipeline is strictly trading (routing checks, quotes, and this
      // very swap execution), not fetching token metadata, so this
      // deliberately never calls Jupiter's catalog lookup. Log loudly rather
      // than silently trusting a last-resort guess if the RPC lookup fails.
      let decimals: number | null = null;
      try {
        const info = await getConnection().getParsedAccountInfo(
          new PublicKey(tokenMint),
        );
        const d = (info.value?.data as any)?.parsed?.info?.decimals;
        if (typeof d === "number" && Number.isFinite(d)) decimals = d;
      } catch {
        // handled below
      }
      if (decimals === null) {
        LOG.error(
          { tokenMint },
          "Could not determine real token decimals — recording cost basis with an assumed value of 9, verify this trade manually",
        );
        decimals = 9;
      }
      const tokensReceived = Number(quote.outAmount) / 10 ** decimals;
      const actualPrice = tokensReceived > 0 ? buySol / tokensReceived : 0;

      const executionResult: ExecutionResult = {
        success: true,
        signature: swapResult.signature ?? "",
        tokensReceived,
        actualPrice,
        amountSol: buySol,
      };

      // Store trade in database under the OWNER's wallet (the address a
      // dashboard viewer actually recognizes and queries by), not the
      // generated hot-wallet address that signed it — see db.service.ts's
      // viewerWalletFilter(), which matches trades on this field.
      await dbService.addTrade({
        type: "buy",
        token: tokenMint,
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: lamports,
        price: actualPrice,
        pnl: 0,
        wallet: walletContext.ownerWallet,
        simulated: !useReal,
        signature: swapResult.signature || "",
        route: "jupiter",
        custody: "custodial",
      });

      LOG.info(
        `[Stage 2] ✅ Jupiter Buy Execution PASSED (${swapResult.signature})`,
      );
      return {
        passed: true,
        stage: 2,
        stageName: "Jupiter Buy Execution",
        details: { executionResult },
      };
    } catch (error: any) {
      LOG.error(`[Stage 2] ❌ Error: ${error.message}`);
      return {
        passed: false,
        stage: 2,
        stageName: "Jupiter Buy Execution",
        reason: `Error: ${error.message}`,
      };
    }
  }

  // Helper methods
  private buildFailureResult(
    stage: number,
    stageName: string,
    reason: string | undefined,
    results: ValidationResult[],
  ): PipelineResult {
    return {
      success: false,
      failedStage: stage,
      failedStageName: stageName,
      reason: reason || "Unknown error",
      results,
    };
  }

  private async logFailure(
    tokenMint: string,
    stage: number,
    stageName: string,
    reason: string,
  ): Promise<void> {
    try {
      // TODO: Store in database for analysis
      LOG.warn(
        `❌ Token ${tokenMint.slice(
          0,
          8,
        )} FAILED at Stage ${stage} (${stageName}): ${reason}`,
      );
    } catch (error: any) {
      LOG.error(`Error logging failure: ${error.message}`);
    }
  }
}

export default new ValidationPipelineService();
export { ValidationResult, PipelineResult };
