// backend/src/routes/tokens.route.ts
import express from "express";
import { getLogger } from "../utils/logger.js";
import { getLatestTokens } from "../services/tokenPrice.service.js";
import dbService from "../services/db.service.js";
import { getSolPriceUsd } from "../services/jupiter.service.js";
import {
  validateTokenLifecycle,
  validateTokenBatch,
  getLifecycleStatusMessage,
} from "../services/tokenLifecycle.service.js";

const router = express.Router();
const logger = getLogger("tokens.route");

const MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000;

function toCandidateToken(
  token: Awaited<ReturnType<typeof dbService.getTokenState>>,
) {
  if (!token) return null;
  return {
    mint: token.mint,
    symbol: token.symbol || "NEW",
    name: token.name || "New Token",
    price: null,
    priceChange24h: null,
    liquidity: token.liquidityUSD ?? null,
    marketCap: token.marketCapUSD ?? null,
    autoBuyEligible: token.autoBuyEligible === true,
    detectedAt: token.detectedAt,
  };
}

async function getRecentCandidates(autoBuyEligible?: boolean) {
  const tokens = await dbService.getTokensByStates(["DISCOVERED", "TRADABLE"], {
    minCreatedAt: new Date(Date.now() - MAX_CANDIDATE_AGE_MS),
    limit: 100,
  });
  return tokens
    .filter((token) =>
      autoBuyEligible === undefined
        ? true
        : token.autoBuyEligible === autoBuyEligible,
    )
    .map((token) => toCandidateToken(token))
    .filter((token): token is NonNullable<typeof token> => token !== null);
}

/**
 * GET /api/tokens/active
 * Recent webhook candidates, including those that do not meet auto-buy rules.
 */
router.get("/active", async (_req, res) => {
  try {
    return res.json({ success: true, tokens: await getRecentCandidates() });
  } catch (err: any) {
    logger.error("Failed to load active candidates:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/tokens/approved-candidates
 * Recent candidates that passed every Phase 4 auto-buy filter.
 */
router.get("/approved-candidates", async (_req, res) => {
  try {
    return res.json({ success: true, tokens: await getRecentCandidates(true) });
  } catch (err: any) {
    logger.error("Failed to load approved candidates:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/tokens
 * Returns token list from in-memory cache:
 *  - symbol
 *  - mint address
 *  - current price
 *  - 24h change (pnl)
 *  - liquidity
 *  - marketCap
 */
router.get("/", async (_req, res) => {
  try {
    const tokens = getLatestTokens();

    return res.json({
      success: true,
      tokens,
    });
  } catch (err: any) {
    logger.error("❌ Failed to load tokens:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/**
 * GET /api/tokens/sol-price
 * Live SOL/USD price (jupiter.service.ts, 30s-cached) — for frontend
 * SOL->USD display estimates. Previously several UI components hardcoded a
 * stale $150-$200 conversion instead of fetching this.
 */
router.get("/sol-price", async (_req, res) => {
  try {
    const price = await getSolPriceUsd();
    return res.json({ success: true, price });
  } catch (err: any) {
    logger.error("❌ Failed to fetch SOL price:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/tokens/lifecycle/validate
 * Validate lifecycle for a single token or batch of tokens
 * Body: { tokenMint: string } or { tokenMints: string[] }
 */
router.post("/lifecycle/validate", async (req, res) => {
  try {
    const { tokenMint, tokenMints } = req.body;

    if (tokenMint) {
      // Single token validation
      const result = await validateTokenLifecycle(tokenMint);
      const statusMessage = getLifecycleStatusMessage(result);

      return res.json({
        success: true,
        data: {
          ...result,
          statusMessage,
        },
      });
    } else if (tokenMints && Array.isArray(tokenMints)) {
      // Batch validation
      const results = await validateTokenBatch(tokenMints);

      return res.json({
        success: true,
        data: {
          tradable: results.tradable.map((r) => ({
            ...r,
            statusMessage: getLifecycleStatusMessage(r),
          })),
          notTradable: results.notTradable.map((r) => ({
            ...r,
            statusMessage: getLifecycleStatusMessage(r),
          })),
          summary: results.summary,
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Request must include 'tokenMint' or 'tokenMints' field",
      });
    }
  } catch (err: any) {
    logger.error("❌ Lifecycle validation failed:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/**
 * GET /api/tokens/lifecycle/:tokenMint
 * Get lifecycle status for a specific token
 */
router.get("/lifecycle/:tokenMint", async (req, res) => {
  try {
    const { tokenMint } = req.params;

    if (!tokenMint) {
      return res.status(400).json({
        success: false,
        message: "Token mint address is required",
      });
    }

    const result = await validateTokenLifecycle(tokenMint);
    const statusMessage = getLifecycleStatusMessage(result);

    return res.json({
      success: true,
      data: {
        ...result,
        statusMessage,
      },
    });
  } catch (err: any) {
    logger.error("❌ Lifecycle validation failed:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

export default router;
