import express from "express";
import {
  getEffectiveConfig,
  shouldTriggerTrade,
} from "../services/traderConfig.service.js";
import db from "../services/db.service.js";
import { getLogger } from "../utils/logger.js";
import {
  getJupiterQuote,
  buildJupiterSwapPayload,
  getQuoteImpliedPriceSol,
} from "../services/jupiter.service.js";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { validateTradeOpportunity } from "../services/tradeValidation.service.js";
import { getTokenBalance } from "../services/solana.service.js";
import { getOnChainMintSupply } from "../services/tokenSafetyChecks.service.js";
import { canExecuteTrade } from "../services/riskManagement.service.js";

const logger = getLogger("trade.route");
const router = express.Router();
const MAX_RAW_AMOUNT = (1n << 64n) - 1n;

function isPositiveRawAmount(value: unknown): value is number | string {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return false;
  }

  const amount = BigInt(value);
  return amount > 0n && amount <= MAX_RAW_AMOUNT;
}

/**
 * GET /api/trade/manual-buy-candidates?limit=40
 * Tokens a user can pick from on the manual Buy page — the same tradable/
 * validated set the auto-trade discovery pipeline already computes (see
 * candidatePipeline.service.ts's processCandidateMint, which writes state:
 * "TRADABLE" here once a token clears Phase 3 Jupiter validation, then
 * refines it further via Phase 4 filtering), not a separately-invented
 * condition set.
 */
// A "TRADABLE" tokenState doc is never re-verified once written — nothing
// re-checks liquidity/safety on old entries, so without a cutoff a token
// discovered days ago (and possibly rugged since, if it never triggered
// monitor.service.ts's emergency-exit blacklist below) would keep showing up
// here indefinitely. This doesn't replace real safety checks (only an actual
// re-validation would), just bounds how stale a "was tradable" snapshot can
// be before this list stops trusting it.
const MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000;

router.get("/manual-buy-candidates", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const cutoff = Date.now() - MAX_CANDIDATE_AGE_MS;
    // Bounded in the DB (see getRecentTradableTokens); a generous fetch so
    // the confirmedTradableAt-based filter/sort below still has enough rows.
    const tokens = await db.getRecentTradableTokens(
      new Date(cutoff),
      Math.max(limit * 10, 200),
    );
    const candidates = tokens
      .map((t) => ({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        liquidityUSD: t.liquidityUSD ?? 0,
        liquiditySOL: t.liquiditySOL ?? 0,
        marketCapUSD: t.marketCapUSD ?? 0,
        poolAddress: t.poolAddress ?? null,
        // Newest-tradable-first — confirmedTradableAt is when it actually
        // cleared validation; detectedAt (first seen at all) as a fallback
        // for any row missing it.
        tradableAt:
          (t.confirmedTradableAt ?? t.detectedAt)?.toISOString?.() ?? null,
      }))
      .filter((c) => c.tradableAt && new Date(c.tradableAt).getTime() >= cutoff)
      .sort(
        (a, b) =>
          new Date(b.tradableAt!).getTime() - new Date(a.tradableAt!).getTime(),
      )
      .slice(0, limit);
    return res.json({ success: true, candidates });
  } catch (err: any) {
    logger.error("Failed to load manual-buy candidates:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/trade/token-balance?wallet=X&mint=Y
 * The real on-chain SPL balance the connected wallet holds for a mint — used
 * by the manual Sell page to size a "sell my entire holding" request against
 * what's actually there, not a DB-derived approximation.
 */
router.get("/token-balance", async (req, res) => {
  try {
    const wallet = req.query.wallet as string | undefined;
    const mint = req.query.mint as string | undefined;
    if (!wallet || !mint) {
      return res
        .status(400)
        .json({ success: false, message: "wallet and mint are required" });
    }
    const balance = await getTokenBalance(wallet, mint);
    return res.json({ success: true, data: balance });
  } catch (err: any) {
    logger.error("Failed to fetch token balance:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/trade/history?limit=50
 * Recent real trades (buys + sells), newest first. Used to backfill the
 * frontend's Live Feed / Trade History on page load — without this, a
 * freshly-opened dashboard shows nothing for positions/trades that happened
 * before the page was loaded, since the socket-driven feed only ever
 * accumulates events that arrive while the page stays mounted.
 */
router.get("/history", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // Optional — when provided, restricts results to just that wallet's own
    // trades. Read access to your own trade history doesn't warrant the same
    // signature check as a settings change; the wallet address itself isn't
    // secret. When omitted (no wallet connected), there's no specific
    // identity to show trades for — not even the operator's own, which is
    // that wallet's own private activity now too — so this returns empty
    // rather than falling through to db.getTrades()'s unrestricted {} scan,
    // which is reserved for trusted internal engine callers.
    const wallet =
      typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    if (!wallet) {
      return res.json({ success: true, trades: [], total: 0 });
    }
    // `total` is the wallet's full trade count; `trades` is just the latest
    // page, so the dashboard can show "N trades" without fetching them all.
    const [trades, total] = await Promise.all([
      db.getTrades(limit, false, wallet),
      db.countTrades(wallet),
    ]);
    return res.json({ success: true, trades, total });
  } catch (err: any) {
    logger.error("❌ Failed to load trade history:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/trade/validate
 * body: { tokenMint }
 * Returns validation result for 3 critical conditions
 */
router.post("/validate", async (req, res) => {
  try {
    const { tokenMint } = req.body;
    if (!tokenMint) {
      return res
        .status(400)
        .json({ success: false, message: "Missing tokenMint" });
    }

    const validation = await validateTradeOpportunity(tokenMint);
    return res.json({ success: true, validation });
  } catch (error: any) {
    logger.error(`Validation error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// A "POST /api/trade/manual-buy" endpoint used to live here — like the
// generic "POST /api/trade" root endpoint noted below, it held its own
// server-side signing authority (manualBuy.service.ts's executeManualBuy,
// via jupiter.service.ts's executeJupiterSwap with no signer override) that
// always signed with the operator's own env-configured wallet regardless of
// the `wallet` field in the request body — a real fund-misattribution bug,
// not a functioning per-user path. The real manual-buy flow is /prepare +
// /confirm below, where the connected wallet signs its own transaction
// client-side (see frontend/hooks/useTrade.ts, frontend/app/trading/buy).
// Removed along with its now-fully-unused manualBuy.service.ts, rather than
// left reachable with a real signer bug and zero remaining callers.

// A generic "POST /api/trade" (root) endpoint used to live here — a second,
// server-signs-the-transaction execution path alongside the real one below
// (/prepare + /confirm, where the client signs with their own wallet).
// Nothing in the frontend ever called it (confirmed against every fetcher()/
// fetch() call in frontend/), and its trust model — the backend holding
// signing authority for an arbitrary `wallet` param — doesn't match how any
// live path actually works. Removed rather than left as an unused, divergent
// second way to execute a real trade.

/**
 * POST /api/trade/prepare
 * Prepare an unsigned transaction for the frontend to sign
 */
router.post("/prepare", async (req, res) => {
  try {
    const { type, inputMint, outputMint, wallet, amountLamports, slippageBps } =
      req.body;

    if (!type || !outputMint || !wallet || !isPositiveRawAmount(amountLamports)) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    // Get the token mint (for buy it's outputMint, for sell it's inputMint)
    const tokenMint = type === "buy" ? outputMint : inputMint;
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // Set default mints if not provided
    const finalInputMint = inputMint || (type === "buy" ? SOL_MINT : tokenMint);
    const finalOutputMint =
      outputMint || (type === "sell" ? SOL_MINT : tokenMint);

    // Re-run the same safety pipeline auto-buy uses, at the moment of
    // purchase — not just at candidate-list time (trade.route.ts's
    // /manual-buy-candidates is a point-in-time snapshot that can go stale;
    // see its own staleness cutoff). A sell is never blocked here — refusing
    // to let someone exit a position they already hold would be strictly
    // worse than letting a risky sell through.
    if (type === "buy") {
      const validation = await validateTradeOpportunity(tokenMint);
      if (!validation.approved) {
        return res.status(400).json({
          success: false,
          message: `Token failed safety validation: ${validation.reason}`,
        });
      }
    }

    // Check trader config to see if trade should trigger
    const config = await getEffectiveConfig(wallet, tokenMint);

    // Enforce the configured minimum/trigger market cap server-side. Previously this
    // only ever ran client-side (token-config-modal.tsx), which a direct API
    // call bypasses entirely — this endpoint would prepare (and /confirm
    // would happily execute) a buy regardless of whether the user's own
    // trigger condition was actually met.
    if (type === "buy") {
      let currentMarketCapSol = 0;
      try {
        // Market cap computed from a small reference Jupiter quote × on-chain
        // circulating supply — Birdeye has been removed from this codebase
        // entirely. See getQuoteImpliedPriceSol's own doc comment for the
        // tradeoff of using a quote as a fair-value price source.
        const supplyInfo = await getOnChainMintSupply(tokenMint);
        if (supplyInfo.available) {
          const priceSol = await getQuoteImpliedPriceSol(
            tokenMint,
            supplyInfo.decimals,
          );
          currentMarketCapSol = priceSol ? priceSol * supplyInfo.supply : 0;
        }
      } catch (err: any) {
        logger.warn(
          `Failed to fetch market cap for trigger check on ${tokenMint.slice(
            0,
            8,
          )}...: ${err.message}`,
        );
      }

      const shouldTrigger =
        Number.isFinite(currentMarketCapSol) &&
        currentMarketCapSol >= config.minMarketCapSol &&
        (!config.triggerMarketCapSol ||
          currentMarketCapSol >= config.triggerMarketCapSol);
      if (!shouldTrigger) {
        logger.info(
          `⏭️ Trade not triggered: ${tokenMint.slice(
            0,
            8,
          )}... current MC ${currentMarketCapSol.toFixed(
            2,
          )} SOL has not reached configured trigger ${
            config.triggerMarketCapSol
          } SOL`,
        );
        return res.status(400).json({
          success: false,
          message: `Market cap (${currentMarketCapSol.toFixed(
            2,
          )} SOL) has not reached the configured trigger (${
            config.triggerMarketCapSol
          } SOL)`,
        });
      }
    }

    logger.info(
      `Preparing Jupiter ${type} trade for token ${tokenMint.slice(0, 8)}...`,
    );

    const effectiveSlippageBps = slippageBps ?? config.slippageBps;
    if (
      !Number.isInteger(effectiveSlippageBps) ||
      effectiveSlippageBps < 10 ||
      effectiveSlippageBps > 10_000
    ) {
      return res.status(400).json({
        success: false,
        message: "Slippage must be a whole number from 10 to 10000 basis points",
      });
    }

    if (type === "buy") {
      const risk = await canExecuteTrade(Number(amountLamports) / 1e9, wallet, {
        ownerWallet: wallet,
        maxDailyLossPct: config.maxDailyLossPct,
        maxRiskPerTradePct: config.maxRiskPerTradePct,
        // The daily-loss breaker still applies; the %-of-equity size cap
        // does not (it never did before this check existed, and at its 2%
        // default it refused any normal manual buy — 0.02 SOL on a 1 SOL
        // wallet). The amount a user types for a manual buy is their call.
        enforcePerTradeCap: false,
      });
      if (!risk.allowed) {
        return res.status(400).json({
          success: false,
          message: risk.reason || "Trade blocked by risk limits",
        });
      }
    }

    const quote = await getJupiterQuote(
      finalInputMint,
      finalOutputMint,
      amountLamports,
      effectiveSlippageBps,
    );

    if (!quote) {
      const errorMessage = "No Jupiter route found for this token.";
      const suggestion =
        "Verify the token address is correct and has sufficient liquidity.";

      logger.error(
        `No Jupiter quote available for ${tokenMint.slice(
          0,
          8,
        )}... - ${errorMessage}`,
      );

      return res.status(400).json({
        success: false,
        message: `${errorMessage} ${suggestion}`,
        tokenAddress: tokenMint,
        dexScreenerUrl: `https://dexscreener.com/solana/${tokenMint}`,
        canRetry: false,
      });
    }

    // Build unsigned transaction
    const { swapTransaction } = await buildJupiterSwapPayload(
      quote,
      wallet,
      config.priorityFeeSol,
    );

    logger.info(`Prepared Jupiter ${type} transaction for ${wallet}`);

    return res.json({
      success: true,
      data: {
        transaction: swapTransaction,
        config: config,
        quote: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          inAmount: quote.inAmount,
          slippageBps: quote.slippageBps,
        },
        slippageBps: quote.slippageBps,
      },
    });
  } catch (err: any) {
    logger.error("Prepare trade error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * POST /api/trade/confirm
 * Confirm and execute a client-signed transaction (Jupiter)
 */
router.post("/confirm", async (req, res) => {
  try {
    const {
      signedTransaction,
      type,
      token,
      amountLamports,
      wallet,
      slippageBps,
    } = req.body;

    if (
      (type !== "buy" && type !== "sell") ||
      !token ||
      !wallet ||
      !isPositiveRawAmount(amountLamports)
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters",
      });
    }

    if (!signedTransaction) {
      return res.status(400).json({
        success: false,
        message: "Signed transaction required for Jupiter trades",
      });
    }

    const effectiveConfig = await getEffectiveConfig(wallet, token);
    const effectiveSlippageBps = slippageBps ?? effectiveConfig.slippageBps;
    if (
      !Number.isInteger(effectiveSlippageBps) ||
      effectiveSlippageBps < 10 ||
      effectiveSlippageBps > 10_000
    ) {
      return res.status(400).json({
        success: false,
        message: "Slippage must be a whole number from 10 to 10000 basis points",
      });
    }

    let signature: string;
    let price: number;

    // Deserialize and send the client-signed transaction
    logger.info(
      `Executing ${type} trade via Jupiter for token ${token.slice(0, 8)}...`,
    );

    const connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const txBuffer = Buffer.from(signedTransaction, "base64");
    const versionedTx = VersionedTransaction.deserialize(txBuffer);
    const actualSigner = versionedTx.message.staticAccountKeys[0]?.toBase58();
    if (!actualSigner || actualSigner !== wallet) {
      return res.status(400).json({
        success: false,
        message: "Signed transaction fee payer does not match wallet",
      });
    }

    // Send transaction to Solana
    signature = await connection.sendTransaction(versionedTx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3,
    });

    logger.info(`Transaction sent: ${signature}`);

    // Confirm transaction
    const latestBlockhash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );

    if (confirmation.value.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    }

    // Do not trust req.body.wallet — it's an unverified client claim, and
    // this is the exact place a caller could otherwise attribute a trade to
    // someone else's wallet. The transaction just landed on-chain, which
    // only happens if its fee-payer's signature verified against the fee
    // payer's own key (enforced by the Solana runtime itself), so the fee
    // payer IS the real, cryptographically-proven signer.
    // Real price (SOL per token) from a fresh same-direction quote — this used to
    // be Math.random(), which fabricated the recorded price/PnL for every trade
    // regardless of whether it succeeded. This is still a post-trade estimate
    // (a fresh quote, not a parse of this exact transaction's balance deltas —
    // and it assumes 9 token decimals, matching the fallback approximation
    // used elsewhere in this codebase when real decimals can't be resolved),
    // but it's grounded in real market data instead of being invented outright.
    price = 0;
    try {
      const quoteInputMint =
        type === "buy" ? "So11111111111111111111111111111111111111112" : token;
      const quoteOutputMint =
        type === "buy" ? token : "So11111111111111111111111111111111111111112";
      const [priceQuote, supplyInfo] = await Promise.all([
        getJupiterQuote(
          quoteInputMint,
          quoteOutputMint,
          amountLamports,
          effectiveSlippageBps,
        ),
        getOnChainMintSupply(token),
      ]);
      if (priceQuote?.outAmount) {
        const amountForEstimate = Number(amountLamports);
        const solAmount = amountForEstimate / 1e9;
        const tokenDecimals = supplyInfo.available ? supplyInfo.decimals : 9;
        const tokenAmount = Number(priceQuote.outAmount) / 10 ** tokenDecimals;
        price =
          type === "buy" ? solAmount / tokenAmount : tokenAmount / solAmount;
      }
    } catch (err: any) {
      logger.warn(`Failed to compute real trade price: ${err.message}`);
    }

    // Record trade in database
    const pnl = 0; // Will be calculated later based on position tracking

    const trade = await db.addTrade({
      type,
      token: token,
      inputMint:
        type === "buy" ? "So11111111111111111111111111111111111111112" : token,
      outputMint:
        type === "buy" ? token : "So11111111111111111111111111111111111111112",
      // TradeRecord stores amounts as numbers. Keep the raw amount as a
      // string through Jupiter quoting, then convert only for this legacy
      // approximate reporting record; the signed transaction remains exact.
      amount: Number(amountLamports),
      price,
      pnl,
      wallet: actualSigner || wallet || "unknown",
      simulated: false,
      signature,
      timestamp: new Date(),
      // This whole route only ever executes a transaction the connected
      // wallet itself signed (see actualSigner above) — it never touches a
      // custodial keypair.
      custody: "self",
    });

    // Keep this position's open/closed state in step with what the trade did
    // (utils/positionState.ts). A manual BUY (re)opens it; a SELL that leaves
    // nothing in the wallet closes it. Without the sell half, a manual
    // position sold at a loss stayed "open" forever (its netSol stays
    // positive) and kept showing up on the Sell page with nothing to sell.
    // Best-effort: a failure here must never fail the confirmed trade.
    try {
      const holder = actualSigner || wallet;
      if (holder) {
        if (type === "buy") {
          await db.updatePositionMetadata(token, holder, { remainingPct: 100 });
        } else {
          const { raw } = await getTokenBalance(holder, token);
          if (/^0*$/.test(raw)) {
            await db.updatePositionMetadata(token, holder, { remainingPct: 0 });
          }
        }
      }
    } catch (err: any) {
      logger.warn(
        `Could not update position state after ${type}: ${err?.message}`,
      );
    }

    // Targeted to the signer's own wallet room, not a global broadcast —
    // a manual trade is that wallet's own private activity, not the bot's
    // public activity (see tradeFeed emits elsewhere, which stay global —
    // those are the shared bot's own trades, which everyone is meant to see).
    const io = (req.app as any)?.get?.("io") ?? (req.app as any)?.locals?.io;
    if (io && actualSigner) {
      io.to(actualSigner).emit("tradeFeed", trade);
    } else {
      io?.emit?.("tradeFeed", trade);
    }

    logger.info(`Confirmed ${type} trade (Jupiter): ${signature}`);

    return res.json({
      success: true,
      data: trade,
    });
  } catch (err: any) {
    logger.error("Confirm trade error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * POST /api/trade/calculate-risk
 * Calculate trade size based on risk parameters
 * Body: { balance, riskPercent, riskAmount }
 */
router.post("/calculate-risk", async (req, res) => {
  try {
    const { balance, riskPercent, riskAmount } = req.body;

    if (!balance || typeof balance !== "number") {
      return res.status(400).json({
        success: false,
        message: "Balance is required and must be a number",
      });
    }

    let calculatedAmount = 0;
    let calculatedPercent = 0;

    // If risk amount is provided, use it directly
    if (riskAmount && typeof riskAmount === "number" && riskAmount > 0) {
      calculatedAmount = riskAmount;
      calculatedPercent = (riskAmount / balance) * 100;
    }
    // If risk percent is provided, calculate amount from percentage
    else if (
      riskPercent &&
      typeof riskPercent === "number" &&
      riskPercent > 0
    ) {
      calculatedPercent = riskPercent;
      calculatedAmount = (balance * riskPercent) / 100;
    }
    // Default to 1% of balance
    else {
      calculatedPercent = 1;
      calculatedAmount = balance * 0.01;
    }

    // Cap at 100% of balance
    if (calculatedAmount > balance) {
      calculatedAmount = balance;
      calculatedPercent = 100;
    }

    // Ensure minimum trade size (0.001 SOL)
    if (calculatedAmount < 0.001) {
      calculatedAmount = 0.001;
      calculatedPercent = (0.001 / balance) * 100;
    }

    logger.info(
      `Risk calculation: Balance=${balance.toFixed(
        4,
      )} SOL, Risk=${calculatedPercent.toFixed(
        2,
      )}%, Amount=${calculatedAmount.toFixed(4)} SOL`,
    );

    return res.json({
      success: true,
      data: {
        balance,
        riskPercent: Number(calculatedPercent.toFixed(2)),
        riskAmount: Number(calculatedAmount.toFixed(4)),
        amountLamports: Math.floor(calculatedAmount * 1e9),
        recommendation: {
          conservative: Number((balance * 0.01).toFixed(4)), // 1%
          moderate: Number((balance * 0.025).toFixed(4)), // 2.5%
          aggressive: Number((balance * 0.05).toFixed(4)), // 5%
        },
      },
    });
  } catch (err: any) {
    logger.error("Risk calculation error: " + String(err));
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
    });
  }
});

/**
 * Pool monitoring endpoints removed - Jupiter-only system
 */

export default router;
