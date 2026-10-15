jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    getPositions: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../services/pnlTracker.service.js", () => ({
  __esModule: true,
  default: {
    stopTracking: jest.fn(),
  },
}));

jest.mock("../services/jupiter.service.js", () => ({
  __esModule: true,
  getJupiterQuote: jest.fn(),
  executeJupiterSwap: jest.fn(),
  getSolPriceUsd: jest.fn(),
}));

jest.mock("../services/emergencyExit.service.js", () => ({
  __esModule: true,
  checkAllEmergencyTriggers: jest.fn(),
}));

jest.mock("../services/notifications/notify.service.js", () => ({
  __esModule: true,
  default: { notifyError: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../services/userWallet.service.js", () => ({
  __esModule: true,
  default: { getUserWalletKeypair: jest.fn() },
}));

jest.mock("../services/solana.service.js", () => ({
  __esModule: true,
  getConnection: jest.fn(),
  loadKeypairFromEnv: jest.fn(),
}));

import dbService from "../services/db.service.js";
import {
  resolveExitCause,
  startPositionMonitor,
} from "../services/monitor.service.js";

describe("post-entry position monitoring", () => {
  it.each([
    ["TP", 0.1, 0.1, 0.3, false],
    ["SL", -0.3, 0.1, 0.3, false],
    ["TRAILING", 0.2, 0.1, 0.3, true],
  ])(
    "identifies %s as the cause of an exit",
    (expected, pnl, tp, sl, trailing) => {
      expect(resolveExitCause(pnl, tp, sl, trailing)).toBe(expected);
    },
  );

  it("starts an immediate position check and returns a stop handle", async () => {
    const stop = startPositionMonitor({} as any, { intervalMs: 60_000 });

    await new Promise((resolve) => setImmediate(resolve));

    expect(dbService.getPositions).toHaveBeenCalled();
    stop();
  });
});

import {
  isPlausiblePnl,
  realizedPnlFromProceeds,
  MAX_PLAUSIBLE_PNL,
} from "../services/monitor.service.js";

describe("price sanity guard", () => {
  it("accepts normal moves and rejects a broken reference quote", () => {
    expect(isPlausiblePnl(0.12)).toBe(true);
    expect(isPlausiblePnl(-0.9999)).toBe(true);
    expect(isPlausiblePnl(MAX_PLAUSIBLE_PNL)).toBe(true);
    // The real case from the DB: +10,758,452% on a drained pool.
    expect(isPlausiblePnl(107584.5)).toBe(false);
    expect(isPlausiblePnl(Number.NaN)).toBe(false);
    expect(isPlausiblePnl(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("realized P&L of a full exit", () => {
  it("uses the SOL actually received against the SOL still invested", () => {
    // 0.03 SOL invested, sell returns 0.036 SOL -> +20%
    expect(realizedPnlFromProceeds(36_000_000, 0.03, 9.9)).toBeCloseTo(0.2, 9);
    // returns 0.015 SOL -> -50%, whatever the reference quote estimated
    expect(realizedPnlFromProceeds(15_000_000, 0.03, 0.48)).toBeCloseTo(-0.5, 9);
  });

  it("falls back to the estimate only when there is no sell quote or no cost basis", () => {
    expect(realizedPnlFromProceeds(0, 0.03, 0.48)).toBe(0.48);
    expect(realizedPnlFromProceeds(36_000_000, 0, 0.48)).toBe(0.48);
  });
});
