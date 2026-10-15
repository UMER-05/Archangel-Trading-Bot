// Regression test for the fixed-size auto-buy path: a trader who sets an
// exact SOL amount per trade ("Fixed SOL per trade") must not have every buy
// refused by the per-trade risk cap. Everything is mocked — no network, no DB.
const getBalanceInSolMock = jest.fn();
jest.mock("../services/solana.service.js", () => ({
  __esModule: true,
  getBalanceInSol: (...args: any[]) => getBalanceInSolMock(...args),
}));

jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    getOpenPositionCount: async () => 0,
    getDeployedSol: async () => 0,
    getTrades: async () => [],
  },
}));

import { canExecuteTrade } from "../services/riskManagement.service.js";

const WALLET = "HotWallet1111111111111111111111111111111111";

describe("per-trade cap vs fixed trade amount", () => {
  beforeEach(() => getBalanceInSolMock.mockResolvedValue(1));

  it("shows why auto-buys must not enforce the cap: a 0.1 SOL buy on a 1 SOL wallet is refused at the default 2%", async () => {
    const res = await canExecuteTrade(0.1, WALLET, {
      ownerWallet: WALLET,
      enforcePerTradeCap: true, // what Stage 0 passes when fixedTradeAmountSol is set
      maxRiskPerTradePct: 2,
      maxDailyLossPct: 6,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/exceeds 2% max risk/);
  });

  it("the same buy is allowed when the cap is not enforced (V1 behaviour for every auto-buy)", async () => {
    const res = await canExecuteTrade(0.1, WALLET, {
      ownerWallet: WALLET,
      enforcePerTradeCap: false,
      maxRiskPerTradePct: 2,
      maxDailyLossPct: 6,
    });
    expect(res.allowed).toBe(true);
  });
});
