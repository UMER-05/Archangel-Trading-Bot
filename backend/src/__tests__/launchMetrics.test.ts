import {
  launchMetricsWithinLimits,
  launchMetricsFromTokenState,
  launchAgeWithinWindow,
  LaunchMetrics,
} from "../services/multiUserExecution.service.js";

const config = {
  minMarketCapSol: 3,
  takeProfitPct: 0.1,
  stopLossPct: 0.3,
  maxOpenPositions: 5,
  autoTrade: true,
};

const validMetrics: LaunchMetrics = {
  marketCapSOL: 10,
};

describe("launchMetricsWithinLimits", () => {
  it("accepts a market cap exactly at the configured minimum", () => {
    expect(
      launchMetricsWithinLimits(
        {
          marketCapSOL: config.minMarketCapSol,
        },
        config,
      ),
    ).toBe(true);
  });

  it.each([["market cap SOL below minimum", { marketCapSOL: 2.99 }]])(
    "rejects when %s",
    (_reason, change) => {
      expect(
        launchMetricsWithinLimits({ ...validMetrics, ...change }, config),
      ).toBe(false);
    },
  );

  it("rejects a missing or non-finite SOL market cap", () => {
    expect(
      launchMetricsWithinLimits(
        { ...validMetrics, marketCapSOL: Number.NaN },
        config,
      ),
    ).toBe(false);
  });
});

describe("launchMetricsFromTokenState", () => {
  it("extracts the immutable launch snapshot used by alternate auto-buy paths", () => {
    expect(
      launchMetricsFromTokenState({
        launchMarketCapUSD: 1000,
        launchMarketCapSOL: 10,
      } as any),
    ).toEqual(validMetrics);
  });

  it("returns null when no stored token exists", () => {
    expect(launchMetricsFromTokenState(null)).toBeNull();
  });
});

describe("launchAgeWithinWindow", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("accepts a pool exactly at the configured minimum age", () => {
    expect(launchAgeWithinWindow(new Date(now - 10_000), now, 10)).toBe(true);
  });

  it("rejects missing, invalid, and out-of-window timestamps", () => {
    expect(launchAgeWithinWindow(undefined, now, 0)).toBe(false);
    expect(launchAgeWithinWindow("invalid", now, 0)).toBe(false);
    expect(launchAgeWithinWindow(new Date(now - 5_000), now, 10)).toBe(false);
  });
});
