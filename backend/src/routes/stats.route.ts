// stats.route.ts
import express from "express";
import dbService from "../services/db.service.js";
import portfolioValuationService from "../services/portfolioValuation.service.js";
import logger from "../utils/logger.js";

const router = express.Router();

/* ----------------------------------------------------
   GET /api/stats
   Returns REAL dashboard stats from MongoDB
---------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const wallet = req.query.wallet as string | undefined;
    const stats = await dbService.getStats(wallet);

    // portfolioValue/totalProfitSol/totalProfitPercent from getStats() are
    // ledger-only (no live prices, no deposit total) — overridden here with
    // the real figure: total deposited into the custodial wallet + net PnL
    // (realized + live-priced unrealized). No wallet means nothing to look
    // up, so the zeroed getStats() result stands as-is.
    if (wallet) {
      const valuation = await portfolioValuationService.getPortfolioValuation(
        wallet
      );
      stats.portfolioValue = valuation.portfolioValue;
      stats.totalProfitSol = valuation.totalPnlSol;
      // valuation.totalPnlPercent is a whole percent (e.g. 5.2 meaning
      // +5.2%) — this endpoint's own convention (see stats-panel.tsx, which
      // multiplies by 100 for display) is a decimal fraction, matching how
      // every other PnL-percent field in this codebase is transmitted
      // (positions.route.ts's unrealizedPnlPct, monitor.service.ts's trade
      // pnl, etc.). Sending the whole-percent value here unconverted was
      // the exact pre-existing bug that displayed "-1227.21%" for a -12.27%
      // move.
      stats.totalProfitPercent = valuation.totalPnlPercent / 100;
    }

    return res.json({
      success: true,
      ...stats,
    });
  } catch (err: any) {
    logger.error("❌ Failed to fetch stats:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to load stats.",
    });
  }
});

/* ----------------------------------------------------
   POST /api/stats/update
   Accepts partial updates and merges into DB
   Also broadcasts update via Socket.IO
---------------------------------------------------- */
router.post("/update", async (req, res) => {
  try {
    const updates = req.body;

    // 🔄 Update DB record
    const updatedStats = await dbService.updateStats(updates);

    // 📡 Broadcast live stats update
    const io = req.app?.get?.("io") || req.app?.locals?.io;

    if (io && typeof io.emit === "function") {
      io.emit("stats:update", {
        event: "stats:update",
        payload: updatedStats,
      });
    }

    return res.json({
      success: true,
      data: updatedStats,
    });
  } catch (err: any) {
    logger.error("❌ Stats update error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to update stats.",
    });
  }
});



export default router;
