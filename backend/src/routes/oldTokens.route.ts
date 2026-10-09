// backend/src/routes/oldTokens.route.ts
import express from "express";
import { getLogger } from "../utils/logger.js";
import { getOldTokenUniverse } from "../services/oldTokenUniverse.service.js";
import dbService from "../services/db.service.js";

const router = express.Router();
const logger = getLogger("oldTokens.route");

/**
 * GET /api/old-tokens
 * Returns filtered old tokens with analytics for dashboard/manual trading
 * Query params: minAgeDays, minLiquidityUSD, minVolume24h, limit
 */
router.get("/", async (req, res) => {
  try {
    const {
      minAgeDays = 7,
      minLiquidityUSD = 1000,
      minVolume24h = 500,
      limit = 100,
    } = req.query;
    const tokens = await getOldTokenUniverse({
      minAgeDays: Number(minAgeDays),
      minLiquidityUSD: Number(minLiquidityUSD),
      minVolume24h: Number(minVolume24h),
      limit: Number(limit),
    });
    return res.json({ success: true, tokens });
  } catch (err) {
    logger.error({ err }, "❌ Failed to load old tokens");
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ success: false, message });
  }
});

/**
 * GET /api/old-tokens/:mint
 * Returns analytics, price history, and signals for a specific old token
 */
router.get("/:mint", async (req, res) => {
  try {
    const { mint } = req.params;
    const { minAgeDays = 7 } = req.query;
    const db = await dbService.connect();
    const token = await db.collection("tokenStates").findOne({ mint });
    // isOldToken used to be a field written unconditionally on every token
    // write, which made it true for every token regardless of actual age —
    // this gate was a no-op. Age is derived the same way the list endpoint
    // (getOldTokenUniverse) computes it: from detectedAt.
    const minAgeMs = Number(minAgeDays) * 24 * 60 * 60 * 1000;
    const isOldEnough =
      !!token?.detectedAt &&
      Date.now() - new Date(token.detectedAt).getTime() >= minAgeMs;
    if (!token || !isOldEnough) {
      return res.status(404).json({
        success: false,
        message: "Token not found or not an old token",
      });
    }
    return res.json({ success: true, token });
  } catch (err) {
    logger.error({ err }, "❌ Failed to load old token details");
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ success: false, message });
  }
});

export default router;
