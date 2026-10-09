const getTokenStateMock = jest.fn();
jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: { getTokenState: (...args: any[]) => getTokenStateMock(...args) },
}));

const getJupiterQuoteMock = jest
  .fn()
  .mockResolvedValue({ outAmount: "123456" });
const executeJupiterSwapMock = jest
  .fn()
  .mockResolvedValue({ success: true, signature: "jup-sig" });
jest.mock("../services/jupiter.service.js", () => ({
  __esModule: true,
  getJupiterQuote: (...args: any[]) => getJupiterQuoteMock(...args),
  executeJupiterSwap: (...args: any[]) => executeJupiterSwapMock(...args),
}));

const claimMock = jest.fn().mockResolvedValue(true);
const completeMock = jest.fn().mockResolvedValue(undefined);
const releaseMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/execution/positionExitCoordinator.service.js", () => ({
  __esModule: true,
  claimPositionExit: (...args: any[]) => claimMock(...args),
  completePositionExit: (...args: any[]) => completeMock(...args),
  releasePositionExit: (...args: any[]) => releaseMock(...args),
}));

import { routeSell } from "../services/execution/sellExecutionRouter.service.js";

const FAKE_SIGNER = {
  publicKey: { toBase58: () => "Wallet1111111111111111111111111111111111" },
} as any;

describe("sellExecutionRouter.routeSell", () => {
  const ORIGINAL = process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED;

  beforeEach(() => {
    claimMock.mockClear();
    completeMock.mockClear();
    releaseMock.mockClear();
    getTokenStateMock.mockReset();
    executeJupiterSwapMock.mockClear();
  });

  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED;
    else process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = ORIGINAL;
  });

  it("returns skipped without touching Jupiter when the claim guard denies the attempt", async () => {
    claimMock.mockResolvedValueOnce(false);

    const result = await routeSell({
      tokenMint: "MINT_A",
      wallet: "WALLET_1",
      amountBaseUnits: 1000,
      slippageBps: 100,
      signer: FAKE_SIGNER,
      useRealSwap: true,
    });

    expect(result.route).toBe("skipped");
    expect(executeJupiterSwapMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("routes to Jupiter when the native flag is unset, and completes the claim on success", async () => {
    delete process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED;

    const result = await routeSell({
      tokenMint: "MINT_A",
      wallet: "WALLET_1",
      amountBaseUnits: 1000,
      slippageBps: 100,
      signer: FAKE_SIGNER,
      useRealSwap: true,
    });

    expect(result.route).toBe("jupiter");
    expect(result.success).toBe(true);
    expect(getTokenStateMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("routes to Jupiter when no native executor is registered for the stored dex, and releases on failure", async () => {
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
    getTokenStateMock.mockResolvedValue({
      dex: "raydium-clmm", // no sell-capable executor registered for this in tests
      poolAddress: "PoolAddress1111111111111111111111111111111",
    });
    executeJupiterSwapMock.mockResolvedValueOnce({
      success: false,
      error: "slippage exceeded",
    });

    const result = await routeSell({
      tokenMint: "MINT_A",
      wallet: "WALLET_1",
      amountBaseUnits: 1000,
      slippageBps: 100,
      signer: FAKE_SIGNER,
      useRealSwap: true,
    });

    expect(result.route).toBe("jupiter");
    expect(result.success).toBe(false);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("routes to Jupiter when the position has no stored dex/poolAddress", async () => {
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
    getTokenStateMock.mockResolvedValue({});

    const result = await routeSell({
      tokenMint: "MINT_A",
      wallet: "WALLET_1",
      amountBaseUnits: 1000,
      slippageBps: 100,
      signer: FAKE_SIGNER,
      useRealSwap: true,
    });

    expect(result.route).toBe("jupiter");
  });
});
