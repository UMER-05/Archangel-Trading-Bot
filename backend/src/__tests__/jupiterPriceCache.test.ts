// backend/src/__tests__/jupiterPriceCache.test.ts
// The dashboard must never wait on Jupiter: getCachedQuoteImpliedPriceSol
// answers from the shared price cache instantly and only triggers a
// background refresh. This is what keeps ~10 dashboard polls a minute from
// competing with the buy pipeline for the rate-limited key.
jest.mock("../services/solana.service.js", () => ({
  __esModule: true,
  getConnection: jest.fn(),
  loadKeypairFromEnv: jest.fn(),
}));

import jupiterService, {
  getCachedQuoteImpliedPriceSol,
  getQuoteImpliedPriceSol,
} from "../services/jupiter.service.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("getCachedQuoteImpliedPriceSol", () => {
  let getQuote: jest.SpyInstance;

  beforeEach(() => {
    // 0.01 SOL probe buys 10 tokens (6 decimals) => 0.001 SOL per token.
    getQuote = jest
      .spyOn(jupiterService, "getQuote")
      .mockResolvedValue({ outAmount: "10000000" } as any);
  });
  afterEach(() => getQuote.mockRestore());

  it("returns null immediately for an unseen mint and refreshes in the background", async () => {
    const mint = "MINT_CACHE_A";
    expect(getCachedQuoteImpliedPriceSol(mint, 6)).toBeNull();
    expect(getQuote).toHaveBeenCalledTimes(1); // the background fetch
    await flush();
    await flush();
    // Now cached: served without another Jupiter call.
    expect(getCachedQuoteImpliedPriceSol(mint, 6)).toBeCloseTo(0.001, 12);
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("shares the monitor's fetch instead of starting its own", async () => {
    const mint = "MINT_CACHE_B";
    const monitorRead = getQuoteImpliedPriceSol(mint, 6); // in flight
    expect(getCachedQuoteImpliedPriceSol(mint, 6)).toBeNull();
    await monitorRead;
    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getCachedQuoteImpliedPriceSol(mint, 6)).toBeCloseTo(0.001, 12);
  });

  it("never throws into the caller when Jupiter fails", async () => {
    getQuote.mockRejectedValue(new Error("429 Too Many Requests"));
    const mint = "MINT_CACHE_C";
    expect(() => getCachedQuoteImpliedPriceSol(mint, 6)).not.toThrow();
    await flush();
    await flush();
    expect(getCachedQuoteImpliedPriceSol(mint, 6)).toBeNull();
  });

  it("rejects invalid decimals without touching the cache or Jupiter", () => {
    expect(getCachedQuoteImpliedPriceSol("MINT_CACHE_D", NaN)).toBeNull();
    expect(getQuote).not.toHaveBeenCalled();
  });
});
