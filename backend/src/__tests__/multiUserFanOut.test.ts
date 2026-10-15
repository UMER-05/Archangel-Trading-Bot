// Regression tests for the per-wallet auto-buy fan-out
// (multiUserExecution.service.ts). Everything that touches the network, the
// database, or a real key is mocked — no transaction can be built or sent.
import { Keypair } from "@solana/web3.js";

const USER_OWNER = "UserOwnerWallet11111111111111111111111111111";
const USER_HOT = "UserHotWallet111111111111111111111111111111";
const MINT = "MintAddress1111111111111111111111111111111";

const loadKeypairFromEnvMock = jest.fn();
jest.mock("../services/solana.service.js", () => ({
  __esModule: true,
  loadKeypairFromEnv: () => loadKeypairFromEnvMock(),
}));

const runPipelineMock = jest.fn();
jest.mock("../services/validationPipeline.service.js", () => ({
  __esModule: true,
  default: {
    runPipeline: (...args: any[]) => runPipelineMock(...args),
  },
}));

const traderConfigs = new Map<string, any>();
const effectiveConfigMock = jest.fn();
const launchWindowMock = jest.fn();
jest.mock("../services/traderConfig.service.js", () => ({
  __esModule: true,
  getTraderConfig: async (wallet: string) => traderConfigs.get(wallet) ?? null,
  getEffectiveConfig: (...args: any[]) => effectiveConfigMock(...args),
  getEffectiveLaunchWindowSeconds: (...args: any[]) =>
    launchWindowMock(...args),
}));

jest.mock("../services/userWallet.service.js", () => ({
  __esModule: true,
  default: {
    listAllUserWallets: async () => [
      { ownerWallet: USER_OWNER, hotWalletPublicKey: USER_HOT },
    ],
    getUserWalletBalanceSol: async () => ({ balanceSol: 1 }),
    getUserWalletKeypair: async () => Keypair.generate(),
  },
}));

const tokenStateMock = jest.fn();
jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    getGlobalAutoTradeEnabled: async () => true,
    getTotalTradesCount: async () => 0,
    getTokenState: (...args: any[]) => tokenStateMock(...args),
    updatePositionMetadata: jest.fn().mockResolvedValue(undefined),
  },
}));

import {
  getEligibleWallets,
  runPipelineForAllEligibleWallets,
} from "../services/multiUserExecution.service.js";

const BASE_CONFIG = {
  minMarketCapSol: 3,
  takeProfitPct: 0.1,
  stopLossPct: 0.3,
  maxOpenPositions: 5,
  fixedTradeAmountSol: null,
  slippageBps: 1000,
  priorityFeeSol: 0.00003,
  maxDailyLossPct: 6,
  maxRiskPerTradePct: 2,
  autoTrade: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  traderConfigs.clear();
  traderConfigs.set(USER_OWNER, {
    globalSettings: { autoTradeEnabled: true },
    tokenSpecificSettings: {},
  });
  effectiveConfigMock.mockResolvedValue(BASE_CONFIG);
  launchWindowMock.mockResolvedValue(0);
  tokenStateMock.mockResolvedValue({
    mint: MINT,
    launchMarketCapSOL: 30,
    poolCreatedAt: new Date(Date.now() - 5_000),
  });
  runPipelineMock.mockResolvedValue({ success: true, results: [] });
});

describe("getEligibleWallets — operator key problems", () => {
  it("still returns funded, auto-trade-enabled user wallets when the operator key is missing", async () => {
    loadKeypairFromEnvMock.mockImplementation(() => {
      throw new Error("WALLET_SECRET_KEY (or WALLET_PRIVATE_KEY) missing");
    });

    const wallets = await getEligibleWallets();

    expect(wallets.map((w) => w.ownerWallet)).toEqual([USER_OWNER]);
  });

  it("still returns user wallets when the operator key is the .env.example placeholder", async () => {
    loadKeypairFromEnvMock.mockImplementation(() => {
      throw new Error(
        "WALLET_SECRET_KEY must be either a JSON array [0,1,2,...] or base58 string",
      );
    });

    const wallets = await getEligibleWallets();

    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.publicKey).toBe(USER_HOT);
  });

  it("includes the operator wallet first when its key loads", async () => {
    const operator = Keypair.generate();
    loadKeypairFromEnvMock.mockReturnValue(operator);
    // OPERATOR_WALLET is read from the env at import, so this generated key
    // is gated like any other wallet: give it auto-trade explicitly.
    traderConfigs.set(operator.publicKey.toBase58(), {
      globalSettings: { autoTradeEnabled: true },
      tokenSpecificSettings: {},
    });

    const wallets = await getEligibleWallets();

    expect(wallets.map((w) => w.ownerWallet)).toEqual([
      operator.publicKey.toBase58(),
      USER_OWNER,
    ]);
  });
});

describe("runPipelineForAllEligibleWallets — skipped wallets are reported", () => {
  beforeEach(() => {
    loadKeypairFromEnvMock.mockImplementation(() => {
      throw new Error("no operator key in this test");
    });
  });

  it("reports a launch-age skip as a failed result instead of dropping it silently", async () => {
    launchWindowMock.mockResolvedValue(60); // token is only ~5s old

    const results = await runPipelineForAllEligibleWallets(MINT, 10);

    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]!.ownerWallet).toBe(USER_OWNER);
    expect(results[0]!.result.success).toBe(false);
    expect(results[0]!.result.failedStageName).toBe("Minimum Launch Age");
    expect(results[0]!.result.reason).toContain("60s minimum age");
  });

  it("reports a market-cap skip as a failed result", async () => {
    effectiveConfigMock.mockResolvedValue({ ...BASE_CONFIG, minMarketCapSol: 100 });

    const results = await runPipelineForAllEligibleWallets(MINT, 10);

    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(results[0]!.result.success).toBe(false);
    expect(results[0]!.result.failedStageName).toBe("Minimum Market Cap");
    expect(results[0]!.result.reason).toContain("100 SOL minimum");
  });

  it("keeps skip reasons identical across tokens so the dashboard's dedupe holds", async () => {
    launchWindowMock.mockResolvedValue(60);
    const first = await runPipelineForAllEligibleWallets(MINT, 10);
    tokenStateMock.mockResolvedValue({
      mint: MINT,
      launchMarketCapSOL: 55,
      poolCreatedAt: new Date(Date.now() - 2_000),
    });
    const second = await runPipelineForAllEligibleWallets(MINT, 10);

    expect(first[0]!.result.reason).toBe(second[0]!.result.reason);
  });

  it("does not change the decision for a token that passes both gates", async () => {
    const results = await runPipelineForAllEligibleWallets(MINT, 10);

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    expect(results[0]!.result.success).toBe(true);
  });
});
