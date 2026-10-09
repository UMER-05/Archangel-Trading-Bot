import { getLogger } from "../utils/logger.js";

const log = getLogger("tokenPrice.service");

export type TokenInfo = {
  mint: string;
  symbol?: string | undefined;
  name?: string | undefined;
  decimals?: number | undefined;
  logo?: string | undefined;
  price?: number | null | undefined;
  priceSol?: number | null | undefined;
  marketCap?: number | null | undefined;
  liquidity?: number | null | undefined;
  volume24h?: number | null | undefined;
  priceChange1h?: number | null | undefined;
  priceChange24h?: number | null | undefined;
  circulatingSupply?: number | null | undefined;
  totalSupply?: number | null | undefined;
  // Set once, the first time this mint is ever tracked — never touched by
  // later updates. This is what "newest first" ordering sorts on; insertion
  // order into the Map isn't reliable for that once entries get merged/
  // updated over time (and wasn't being sorted on at all before this).
  discoveredAt: number;
};

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let trackedTokens: TokenInfo[] = [
  // Start with SOL & USDC — expand later automatically
  { mint: SOL_MINT, symbol: "SOL", discoveredAt: 0 },
  { mint: USDC_MINT, symbol: "USDC", discoveredAt: 0 },
];

let priceCache = new Map<string, TokenInfo>();

// Every newly-discovered mint calls addTrackedToken with no cap or eviction —
// unlike the discovery services' own dedup Sets (both explicitly pruned),
// this array grew forever, and the 10s refresh loop re-batches the entire
// thing through Birdeye every cycle: a slow memory leak plus a steadily
// growing rate of outbound API calls over the bot's uptime.
const MAX_TRACKED_TOKENS = Number(process.env.MAX_TRACKED_TOKENS ?? 2000);

function pruneTrackedTokens() {
  if (trackedTokens.length <= MAX_TRACKED_TOKENS) return;
  // Keep SOL/USDC plus the most-recently-added tokens; drop the oldest.
  const pinned = trackedTokens.filter(
    (t) => t.mint === SOL_MINT || t.mint === USDC_MINT,
  );
  const rest = trackedTokens.filter(
    (t) => t.mint !== SOL_MINT && t.mint !== USDC_MINT,
  );
  const kept = rest.slice(-1 * (MAX_TRACKED_TOKENS - pinned.length));
  const keptMints = new Set([...pinned, ...kept].map((t) => t.mint));

  trackedTokens = [...pinned, ...kept];
  for (const mint of priceCache.keys()) {
    if (!keptMints.has(mint)) priceCache.delete(mint);
  }
  log.info(
    { total: trackedTokens.length },
    "Pruned tracked-token list back to the configured cap",
  );
}

/**
 * Register (or update) a tracked token. When the caller already has real data
 * (e.g. straight from Jupiter's /tokens/v2 response at discovery time), pass it
 * in `data` so the token shows up with real price/liquidity/mcap immediately
 * instead of waiting on the Birdeye refresh cycle below, which frequently has no
 * data at all for a token that's only seconds old.
 */
export function addTrackedToken(
  mint: string,
  symbol = "",
  data?: Partial<TokenInfo>,
) {
  const existingIndex = trackedTokens.findIndex((t) => t.mint === mint);
  const discoveredAt = priceCache.get(mint)?.discoveredAt ?? Date.now();
  if (existingIndex === -1) {
    trackedTokens.push({ mint, symbol, discoveredAt });
    log.info(
      { mint: mint.slice(0, 8), symbol, total: trackedTokens.length },
      "✅ Token added to tracked list",
    );
    pruneTrackedTokens();
  }

  const merged: TokenInfo = {
    mint,
    discoveredAt,
    symbol: data?.symbol || symbol || priceCache.get(mint)?.symbol || "NEW",
    name: data?.name ?? priceCache.get(mint)?.name ?? "New Token",
    decimals: data?.decimals ?? priceCache.get(mint)?.decimals ?? 9,
    price: data?.price ?? priceCache.get(mint)?.price ?? null,
    priceSol: data?.priceSol ?? priceCache.get(mint)?.priceSol ?? null,
    marketCap: data?.marketCap ?? priceCache.get(mint)?.marketCap ?? null,
    liquidity: data?.liquidity ?? priceCache.get(mint)?.liquidity ?? null,
    volume24h: data?.volume24h ?? priceCache.get(mint)?.volume24h ?? null,
    priceChange1h:
      data?.priceChange1h ?? priceCache.get(mint)?.priceChange1h ?? null,
    priceChange24h:
      data?.priceChange24h ?? priceCache.get(mint)?.priceChange24h ?? null,
    circulatingSupply:
      data?.circulatingSupply ??
      priceCache.get(mint)?.circulatingSupply ??
      null,
    totalSupply: data?.totalSupply ?? priceCache.get(mint)?.totalSupply ?? null,
  };
  priceCache.set(mint, merged);

  log.debug(
    { total: trackedTokens.length, cacheSize: priceCache.size },
    "Tracked token upserted",
  );
}

export function getLatestTokens(): TokenInfo[] {
  // Newest-discovered first — see TokenInfo.discoveredAt.
  const tokens = Array.from(priceCache.values()).sort(
    (a, b) => b.discoveredAt - a.discoveredAt,
  );
  log.debug({ count: tokens.length }, "Returning tracked tokens");
  return tokens;
}
