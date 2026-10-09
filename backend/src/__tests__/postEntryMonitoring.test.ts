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
