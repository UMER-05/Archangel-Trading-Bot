// backend/src/services/tokenChart.service.ts
import { getLogger } from "../utils/logger.js";

const log = getLogger("tokenChart.service");

export interface ChartPoint {
  time: string; // ISO timestamp
  price: number;
}

/**
 * Historical price chart data for a token.
 *
 * Returns empty (not an error) — this used to be backed by Birdeye's
 * history_price endpoint, which has been removed from this codebase
 * entirely (its API-plan compute-unit limits made it an unreliable
 * dependency). Jupiter has no historical price API of its own, so there is
 * currently NO price-history data source anywhere in this codebase. This
 * function is left in place (returning empty) so callers — routes/tokenChart.route.ts
 * and anything else expecting a ChartPoint[] — keep working rather than
 * throwing, but the chart feature has no real data until a different
 * provider (e.g. DexScreener, GeckoTerminal — several offer free Solana
 * OHLCV endpoints) is wired in here.
 */
export async function getTokenChartData(
  mint: string,
  tf: string = "24h",
): Promise<ChartPoint[]> {
  log.debug(
    { mint: mint.slice(0, 8), tf },
    "Price history unavailable — no provider configured (Birdeye removed)",
  );
  return [];
}
