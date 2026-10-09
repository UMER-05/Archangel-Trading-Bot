// backend/src/services/price.service.ts
//
// Watchlist price-alert checking (see priceAlert.service.ts, the only
// caller of fetchPricesForMints). Prices are USD, matching the unit
// existing stored watchlist alerts (WatchlistToken.priceAlert.targetPrice)
// were always set in — this must stay USD or every alert a user has already
// configured silently breaks by several orders of magnitude.
//
// This used to go through Birdeye's /defi/price and /defi/multi_price
// endpoints directly (a separate integration from birdeye.service.ts, which
// has itself been removed from this codebase entirely). Birdeye is gone
// here too now — price is derived from a small reference Jupiter quote
// (see getQuoteImpliedPriceSol's own doc comment for the tradeoff) times
// the live SOL/USD rate. fetchTokenList/fetchTokenPrices/KNOWN_TOKENS (a
// fixed 4-token list, Birdeye-priced, with no callers anywhere in this
// codebase) have been dropped rather than converted — dead code, not a
// real feature to preserve.
import { getLogger } from "../utils/logger.js";
import { tokenPriceCache } from "./cache.service.js";
import { getQuoteImpliedPriceSol, getSolPriceUsd } from "./jupiter.service.js";
import { getOnChainMintSupply } from "./tokenSafetyChecks.service.js";

const log = getLogger("price.service");

interface PriceEntry {
  price: number; // USD
  source: "jupiter-quote";
}

async function fetchPriceUsd(
  mint: string,
  solPriceUsd: number,
): Promise<number | null> {
  const cacheKey = `price:${mint}`;
  const cached = tokenPriceCache.get<PriceEntry>(cacheKey);
  if (cached) return cached.price;

  try {
    const supplyInfo = await getOnChainMintSupply(mint);
    if (!supplyInfo.available) return null;
    const priceSol = await getQuoteImpliedPriceSol(mint, supplyInfo.decimals);
    if (!priceSol) return null;

    const priceUsd = priceSol * solPriceUsd;
    tokenPriceCache.set(cacheKey, { price: priceUsd, source: "jupiter-quote" });
    return priceUsd;
  } catch (err: any) {
    log.warn({ mint, err: err?.message }, "Price fetch failed");
    return null;
  }
}

/**
 * Fetch USD prices for multiple mints — used by priceAlert.service.ts to
 * check watchlist alerts. Missing entries mean "no route/price available,"
 * not "price is zero."
 */
export async function fetchPricesForMints(
  mints: string[],
): Promise<Record<string, PriceEntry>> {
  if (!mints || mints.length === 0) return {};

  const solPriceUsd = await getSolPriceUsd();
  if (!(solPriceUsd > 0)) {
    log.warn(
      "SOL/USD price unavailable — cannot compute USD prices this cycle",
    );
    return {};
  }

  const results: Record<string, PriceEntry> = {};
  const uniqueMints = [...new Set(mints)];

  await Promise.all(
    uniqueMints.map(async (mint) => {
      const priceUsd = await fetchPriceUsd(mint, solPriceUsd);
      if (priceUsd != null) {
        results[mint] = { price: priceUsd, source: "jupiter-quote" };
      }
    }),
  );

  return results;
}
