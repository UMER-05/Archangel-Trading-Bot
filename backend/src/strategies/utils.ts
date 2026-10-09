import { getLogger } from "../utils/logger.js";

const log = getLogger("strategies-utils");

// Fetch price, liquidity, and volume history for a token, used by strategies that
// need an established trading history (momentum, breakout, mean-reversion).
// Brand-new pool/mint candidates have no history by definition - those are handled
// separately by sniperStrategy via tokenMeta.justLaunched.
//
// Always returns empty — this used to be backed by Birdeye's history_price
// endpoint, which has been removed from this codebase entirely. Jupiter has
// no historical price API of its own, so there is currently NO price-history
// data source anywhere in this codebase. Strategies consuming this already
// gate correctly on "not enough data" (see liquidityGrowthStrategy), so this
// degrades to that same safe path rather than fabricating numbers — but any
// strategy that genuinely needs history will never fire until a different
// provider (e.g. DexScreener, GeckoTerminal) is wired in here.
export async function getTokenHistory(mint: string): Promise<{
  priceHistory: number[];
  liquidityHistory: number[];
  volumeHistory: number[];
}> {
  log.debug(
    { mint: mint.slice(0, 8) },
    "Token history unavailable — no price-history provider configured (Birdeye removed)",
  );
  return {
    priceHistory: [],
    liquidityHistory: [],
    volumeHistory: [],
  };
}
