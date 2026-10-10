// backend/src/routes/admin.route.ts
import express from "express";
import dbService from "../services/db.service.js";
import { executeJupiterSwap } from "../services/jupiter.service.js";
import notify from "../services/notifications/notify.service.js";
import pnlTrackerService from "../services/pnlTracker.service.js";
import userWalletService from "../services/userWallet.service.js";
import { loadKeypairFromEnv } from "../services/solana.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import { getLogger } from "../utils/logger.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";

const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

const router = express.Router();
const log = getLogger("admin.route");

/**
 * GET /api/admin/auto-trade
 * Public status lets the dashboard show this control only to the operator.
 */
router.get("/auto-trade", async (_req, res) => {
  try {
    const enabled = await dbService.getGlobalAutoTradeEnabled();
    return res.json({
      success: true,
      enabled,
      operatorWallet: OPERATOR_WALLET || null,
    });
  } catch (err: any) {
    log.error({ err: err?.message }, "Failed to load global auto-trade state");
    return res.status(503).json({
      success: false,
      error: "Global auto-trade status is unavailable",
    });
  }
});

/**
 * POST /api/admin/auto-trade
 * body: { enabled, walletAuthTimestamp, walletAuthSignature }
 * Only the configured operator wallet can pause/resume auto-buys globally.
 * Existing positions are not sold and continue to be monitored.
 */
router.post("/auto-trade", async (req, res) => {
  try {
    const { enabled, walletAuthTimestamp, walletAuthSignature } =
      req.body ?? {};
    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ success: false, error: "enabled must be true or false" });
    }
    if (!OPERATOR_WALLET) {
      return res.status(503).json({
        success: false,
        error: "Global auto-trade control has no configured operator wallet",
      });
    }

    const verifiedWallet = verifyWalletAuth({
      wallet: OPERATOR_WALLET,
      timestamp: walletAuthTimestamp,
      signature: walletAuthSignature,
    });
    if (!verifiedWallet) {
      return res.status(401).json({
        success: false,
        error: "A valid signature from the configured operator wallet is required",
      });
    }

    await dbService.setGlobalAutoTradeEnabled(enabled);
    const io = (req.app as any).locals.io;
    io?.emit("globalAutoTrade:updated", { enabled });
    log.warn(
      { enabled, operatorWallet: verifiedWallet },
      enabled ? "Global auto-buys resumed" : "Global auto-buys paused",
    );
    return res.json({ success: true, enabled });
  } catch (err: any) {
    log.error({ err: err?.message }, "Failed to update global auto-trade state");
    return res.status(500).json({
      success: false,
      error: "Failed to update global auto-trade state",
    });
  }
});

/**
 * POST /api/admin/force-sell
 * body: { token: string, amountSol?: number, wallet?: string }
 * Force sell a position immediately.
 */
router.post("/force-sell", async (req, res) => {
  try {
    const { token, amountSol, wallet } = req.body;
    if (!token)
      return res
        .status(400)
        .json({ success: false, message: "token required" });

    // compute amount lamports (default: everything). Positions are no
    // longer unique per token — different wallets can independently hold
    // the same token — so an explicit wallet is required to disambiguate
    // which one to sell, unless there's only a single position for it.
    const positions = await dbService.getPositions();
    const matches = positions.filter((x: any) => x.token === token);
    const p = wallet
      ? matches.find((x: any) => x.wallet === wallet)
      : matches.length === 1
      ? matches[0]
      : undefined;
    if (!p) {
      return res.status(matches.length > 1 ? 400 : 404).json({
        success: false,
        message:
          matches.length > 1
            ? "Multiple wallets hold this token — specify wallet to disambiguate"
            : "position not found",
      });
    }

    const amountToSell = amountSol ?? p.netSol;
    const amountLamports = Math.floor(amountToSell * 1e9);
    // No explicit amountSol means "sell everything" (defaults to p.netSol
    // above) — a genuine full close, so the live P&L poll loop for this
    // token should stop rather than keep polling a position we no longer hold.
    const isFullClose = amountSol === undefined;

    // The position's own owner wallet is authoritative for which keypair
    // can actually sign this — not the caller-supplied `wallet`, which is
    // now only used above to disambiguate which position was meant.
    const signer =
      p.wallet === OPERATOR_WALLET
        ? loadKeypairFromEnv()
        : await userWalletService.getUserWalletKeypair(p.wallet);
    if (!signer) {
      return res.status(400).json({
        success: false,
        message: `No signer available for wallet ${p.wallet}`,
      });
    }

    const result = await executeJupiterSwap({
      inputMint: token, // token is the mint address
      outputMint: "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      userPublicKey: signer.publicKey.toBase58(),
      slippageBps: Number(process.env.ADMIN_FORCE_SLIPPAGE || 1) * 100,
      signer,
    });

    // insert sell trade record
    const sellRecord = await dbService.addTrade({
      type: "sell",
      token,
      inputMint: token,
      outputMint: "So11111111111111111111111111111111111111112",
      amount: amountLamports,
      price: p.avgBuyPrice ?? 0,
      pnl: 0,
      wallet: p.wallet,
      simulated: !result.success,
      signature: result.success ? result.signature ?? null : null,
      timestamp: new Date(),
      // This route always resolves a server-held signer (operator's env key
      // or the custodial hot wallet) — never the connected wallet's own key.
      custody: "custodial",
    });

    if (isFullClose && result.success) {
      pnlTrackerService.stopTracking(token, p.wallet);
    }

    // Only include defined optional properties
    notify.notifyTrade({
      id: sellRecord.id,
      type: "sell",
      token: sellRecord.token,
      amountSol: sellRecord.amountSol,
      ...(sellRecord.price !== undefined && { price: sellRecord.price }),
      ...(sellRecord.pnl !== undefined && { pnl: sellRecord.pnl }),
      ...(sellRecord.signature !== undefined && {
        signature: sellRecord.signature,
      }),
      ...(sellRecord.simulated !== undefined && {
        simulated: sellRecord.simulated,
      }),
    });

    // socket — scoped to the position's own owner wallet, not broadcast
    // globally; a force-sell is that wallet's own activity, not the bot's
    // shared public feed.
    const io = req.app?.get?.("io");
    emitToWalletOrGlobal(io, p.wallet, "tradeFeed", {
      id: sellRecord.id,
      type: "sell",
      token: sellRecord.token,
      // tradeFeed's "amount" field is lamports everywhere else it's emitted
      // (candidatePipeline.service.ts) — the frontend (live-feed.tsx)
      // divides by 1e9 to get SOL. Sending raw SOL
      // here made every force-sell show up ~1e9x too small on the dashboard.
      amount: Math.round(sellRecord.amountSol * 1e9),
      price: sellRecord.price,
      pnl: sellRecord.pnl,
      signature: sellRecord.signature,
      simulated: sellRecord.simulated,
      timestamp: sellRecord.timestamp,
    });

    return res.json({ success: true, data: sellRecord });
  } catch (err: any) {
    log.error("force-sell failed: " + (err?.message || err));
    notify
      .notifyError({ source: "admin.force-sell", message: err?.message })
      .catch(() => {});
    return res
      .status(500)
      .json({ success: false, message: err?.message || "force-sell failed" });
  }
});

// A /cancel-order endpoint used to live here. Removed: a Solana swap is
// atomic once submitted — it either lands or expires, there's no pending
// on-chain order to cancel — and the handler admitted as much in its own
// response message ("you may implement...") without ever actually marking
// anything. Nothing called it. If trade lifecycle tracking (pending/failed/
// expired) is ever wanted, that needs a real `status` field on TradeRecord
// (db.service.ts) set at /prepare and /confirm time, not a bolt-on cancel
// endpoint with nothing to attach to.

export default router;
