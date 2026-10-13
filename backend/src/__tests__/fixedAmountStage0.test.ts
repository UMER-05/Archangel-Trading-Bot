// Stage 0 must size a fixed-amount auto-buy at exactly the trader's amount
// and must NOT subject it to the per-trade risk cap (V1 behaviour: the cap
// never applied to auto-buys). Everything external is mocked — no network,
// no database, no signing.
import { Keypair } from "@solana/web3.js";

jest.mock("../services/jupiter.service.js");
jest.mock("../services/solana.service.js");

const canExecuteTradeMock = jest.fn().mockResolvedValue({ allowed: true });
jest.mock("../services/riskManagement.service.js", () => ({
  __esModule: true,
  canExecuteTrade: (...args: any[]) => canExecuteTradeMock(...args),
}));

const effectiveConfig = {
  minMarketCapSol: 3,
  takeProfitPct: 0.1,
  stopLossPct: 0.3,
  maxOpenPositions: 5,
  fixedTradeAmountSol: 0.1,
  slippageBps: 1000,
  priorityFeeSol: 0.00003,
  maxDailyLossPct: 6,
  maxRiskPerTradePct: 2,
  autoTrade: true,
};
jest.mock("../services/traderConfig.service.js", () => ({
  __esModule: true,
  getEffectiveConfig: async () => effectiveConfig,
  getTraderConfig: async () => ({
    globalSettings: { fixedTradeAmountSol: 0.1 },
    tokenSpecificSettings: {},
  }),
}));

jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    getGlobalAutoTradeEnabled: async () => true,
    getOpenPositionCount: async () => 0,
    getTotalTradesCount: async () => 0,
    getBudgetState: async () => ({ deployedSol: 0, realizedLossSol: 0 }),
    addTrade: jest.fn(),
  },
}));

import * as solana from "../services/solana.service.js";
import validationPipelineService from "../services/validationPipeline.service.js";

const MINT = "MintAddress1111111111111111111111111111111";

describe("Stage 0 with a fixed trade amount", () => {
  it("sizes the buy at the trader's exact amount and does not enforce the per-trade cap", async () => {
    (solana.getBalanceInSol as jest.Mock).mockResolvedValue(1); // 1 SOL wallet
    const keypair = Keypair.generate();
    const ctx = {
      ownerWallet: keypair.publicKey.toBase58(),
      publicKey: keypair.publicKey.toBase58(),
      keypair,
    };

    // Stage 1 fails (Jupiter is automocked and returns no quote) — that is
    // fine: this test is about what Stage 0 handed to the risk check.
    const result = await validationPipelineService.runPipeline(MINT, 10, ctx);

    expect(canExecuteTradeMock).toHaveBeenCalledTimes(1);
    const [buySol, , options] = canExecuteTradeMock.mock.calls[0];
    expect(buySol).toBeCloseTo(0.1, 9);
    expect(options.enforcePerTradeCap).toBe(false);
    expect(options.maxDailyLossPct).toBe(6);
    expect(result.failedStage).not.toBe(0);
  });
});
