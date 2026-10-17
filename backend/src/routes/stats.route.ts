// stats.route.ts
import express from "express";
import dbService from "../services/db.service.js";
import { getWalletStats } from "../services/stats.service.js";
import logger from "../utils/logger.js";

const router = express.Router();

/* ----------------------------------------------------
   GET /api/stats
   Returns REAL dashboard stats from MongoDB
---------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const wallet = req.query.wallet as string | undefined;
    // Same numbers the socket pushes — see stats.service.ts.
    const stats = await getWalletStats(wallet);

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
