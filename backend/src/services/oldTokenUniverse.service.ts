// backend/src/services/oldTokenUniverse.service.ts
// Service to select/filter old tokens for analytics and manual trading

import { Db } from "mongodb";
import { connect, OldTokenState } from "./db.service.js";

/**
 * Filters tokens to select "old tokens" based on age, liquidity, volume, and authority.
 * Returns tokens with analytics for dashboard/manual trading.
 */
export async function getOldTokenUniverse({
  minAgeDays = 7,
  minLiquidityUSD = 1000,
  minVolume24h = 500,
  excludeBlacklisted = true,
  limit = 100,
}: {
  minAgeDays?: number;
  minLiquidityUSD?: number;
  minVolume24h?: number;
  excludeBlacklisted?: boolean;
  limit?: number;
} = {}): Promise<OldTokenState[]> {
  const db: Db = await connect();
  const now = new Date();
  const minDetectedAt = new Date(
    now.getTime() - minAgeDays * 24 * 60 * 60 * 1000
  );
  const query: any = {
    detectedAt: { $lte: minDetectedAt },
    liquidityUSD: { $gte: minLiquidityUSD },
    $or: [
      { "analytics.volume24h": { $gte: minVolume24h } },
      { volume24h: { $gte: minVolume24h } },
    ],
  };
  if (excludeBlacklisted) {
    query.state = { $ne: "BLACKLISTED" };
  }
  // Optionally, add more filters (e.g., authority checks)
  const tokens = await db
    .collection<OldTokenState>("tokenStates")
    .find(query)
    .sort({ liquidityUSD: -1, "analytics.priceChange7d": -1 })
    .limit(limit)
    .toArray();
  // Mark as old token
  return tokens.map((t) => ({ ...t, isOldToken: true }));
}
