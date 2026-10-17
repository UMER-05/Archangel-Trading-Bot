// backend/src/__tests__/portfolioValuation.test.ts
// The dashboard's Portfolio Value / Total Profit come from here. Two real
// failures this guards against: pricing every past losing trade on each poll
// (netSol stays positive on a loss, so "netSol > 0" is not "still open"),
// and a garbage reference quote turning a 0.004 SOL position into +112,000 SOL.
jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    getPortfolioPnL: jest.fn(),
    getPositions: jest.fn(),
  },
}));
jest.mock("../services/jupiter.service.js", () => ({
  __esModule: true,
  getCachedQuoteImpliedPriceSol: jest.fn(),
}));
jest.mock("../services/tokenSafetyChecks.service.js", () => ({
  __esModule: true,
  getOnChainMintSupply: jest
    .fn()
    .mockResolvedValue({ decimals: 6, supply: 1_000_000, available: true }),
}));
jest.mock("../services/depositTracker.service.js", () => ({
  __esModule: true,
  default: { getTotalDepositedSol: jest.fn().mockResolvedValue(0.1) },
}));
jest.mock("../services/monitor.service.js", () => ({
  __esModule: true,
  isPlausiblePnl: (pnl: number) => Number.isFinite(pnl) && pnl <= 99,
}));

import dbService from "../services/db.service.js";
import { getCachedQuoteImpliedPriceSol } from "../services/jupiter.service.js";
import { getPortfolioValuation } from "../services/portfolioValuation.service.js";

const db = dbService as unknown as {
  getPortfolioPnL: jest.Mock;
  getPositions: jest.Mock;
};
const quote = getCachedQuoteImpliedPriceSol as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  db.getPortfolioPnL.mockResolvedValue({ realizedPnlSol: 0.01 });
});

describe("getPortfolioValuation", () => {
  it("prices only positions that are still open, not past losing trades", async () => {
    db.getPositions.mockResolvedValue([
      // Still held: 100% remaining.
      { token: "OPEN", netSol: 0.004, avgBuyPrice: 0.001, remainingPct: 100 },
      // Sold at a loss: cost 0.01, got back 0.004 -> netSol 0.006 but closed.
      { token: "CLOSED_LOSS", netSol: 0.006, avgBuyPrice: 0.001, remainingPct: 0 },
      // The user's own manual position: not the bot's to value.
      { token: "MANUAL", netSol: 0.05, avgBuyPrice: 0.001, custody: "self" },
    ]);
    quote.mockReturnValue(0.0012); // +20%

    const v = await getPortfolioValuation("WALLET");

    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote.mock.calls[0][0]).toBe("OPEN");
    // (0.0012 - 0.001) * (0.004 / 0.001) = 0.0008
    expect(v.unrealizedPnlSol).toBeCloseTo(0.0008, 9);
    expect(v.totalPnlSol).toBeCloseTo(0.0108, 9);
    expect(v.portfolioValue).toBeCloseTo(0.1108, 9);
  });

  it("ignores a reference price that implies an impossible gain", async () => {
    db.getPositions.mockResolvedValue([
      { token: "OPEN", netSol: 0.0044, avgBuyPrice: 0.00122, remainingPct: 100 },
    ]);
    quote.mockReturnValue(0.897); // +73,000%: a bad quote, not a price

    const v = await getPortfolioValuation("WALLET");

    expect(v.unrealizedPnlSol).toBe(0);
    expect(v.totalPnlSol).toBeCloseTo(0.01, 9);
    expect(v.portfolioValue).toBeCloseTo(0.11, 9);
  });

  it("counts a real loss on an open position", async () => {
    db.getPositions.mockResolvedValue([
      { token: "OPEN", netSol: 0.01, avgBuyPrice: 0.002, remainingPct: 100 },
    ]);
    quote.mockReturnValue(0.001); // -50%

    const v = await getPortfolioValuation("WALLET");
    expect(v.unrealizedPnlSol).toBeCloseTo(-0.005, 9);
  });
});
