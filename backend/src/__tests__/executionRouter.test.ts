import { routeExecution } from "../services/execution/executionRouter.service.js";
import type { CandidateMint } from "../services/tokenExtraction.service.js";
import { NATIVE_EXECUTOR_REGISTRY } from "../services/execution/nativeExecutor.types.js";

const runPipelineForAllEligibleWalletsMock = jest
  .fn()
  .mockResolvedValue([
    { ownerWallet: "wallet1", result: { success: true, results: [] } },
  ]);

jest.mock("../services/multiUserExecution.service.js", () => ({
  __esModule: true,
  default: {
    runPipelineForAllEligibleWallets: (...args: any[]) =>
      runPipelineForAllEligibleWalletsMock(...args),
  },
}));

const runNativePipelineMock = jest.fn().mockResolvedValue({
  success: true,
  results: [],
  executionResult: { success: true, signature: "native-sig" },
});
jest.mock("../services/validationPipeline.service.js", () => ({
  __esModule: true,
  default: {
    runNativePipeline: (...args: any[]) => runNativePipelineMock(...args),
  },
}));

const verifyRaydiumPoolMock = jest.fn().mockResolvedValue({
  verified: true,
  poolType: "raydium-cpmm",
});
jest.mock("../services/execution/poolVerification.service.js", () => ({
  __esModule: true,
  verifyRaydiumPool: (...args: any[]) => verifyRaydiumPoolMock(...args),
}));

const CANDIDATE: CandidateMint = {
  mint: "MintAddress1111111111111111111111111111111",
  poolAddress: "PoolAddress111111111111111111111111111111",
  dex: "raydium-cpmm",
  poolCreatedAt: new Date(),
};

describe("executionRouter.routeExecution", () => {
  const ORIGINAL_ENV = process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED;

  beforeEach(() => {
    runPipelineForAllEligibleWalletsMock.mockClear();
    runNativePipelineMock.mockClear();
    verifyRaydiumPoolMock.mockClear();
    NATIVE_EXECUTOR_REGISTRY.clear();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED;
    } else {
      process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = ORIGINAL_ENV;
    }
    NATIVE_EXECUTOR_REGISTRY.clear();
  });

  it("routes to Jupiter when the flag is unset (default)", async () => {
    delete process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED;
    const result = await routeExecution(CANDIDATE, 10);
    expect(result.route).toBe("jupiter");
    expect(runPipelineForAllEligibleWalletsMock).toHaveBeenCalledWith(
      CANDIDATE.mint,
      10,
    );
  });

  it("routes to Jupiter even with the flag enabled, since no executor is registered", async () => {
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
    const result = await routeExecution(CANDIDATE, 10);
    expect(result.route).toBe("jupiter");
    expect(result.nativeFallbackReason).toBeUndefined();
  });

  it("routes to Jupiter for a non-Raydium dex regardless of the flag", async () => {
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
    const result = await routeExecution(
      { ...CANDIDATE, dex: "orca-whirlpool" },
      10,
    );
    expect(result.route).toBe("jupiter");
  });

  // This is the regression test for the bug found after Stage A/B smoke
  // testing: the router used to unconditionally throw a placeholder
  // instead of ever actually invoking a registered executor. This test
  // fails loudly if that regresses — it asserts the native path is
  // ACTUALLY called with the fan-out mechanism, not just that routing
  // "decides" to go native.
  it("actually invokes the registered executor's buy() through the real per-wallet fan-out when everything is eligible", async () => {
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
    const buyMock = jest
      .fn()
      .mockResolvedValue({ success: true, signature: "sig" });
    NATIVE_EXECUTOR_REGISTRY.set("raydium-cpmm", {
      poolType: "raydium-cpmm",
      buy: buyMock,
    });

    const result = await routeExecution(CANDIDATE, 10);

    expect(result.route).toBe("raydium-native");
    expect(verifyRaydiumPoolMock).toHaveBeenCalledWith(
      CANDIDATE.dex,
      CANDIDATE.poolAddress,
    );
    expect(runPipelineForAllEligibleWalletsMock).toHaveBeenCalledWith(
      CANDIDATE.mint,
      10,
      expect.any(Function),
    );

    // Simulate what runPipelineForAllEligibleWallets would actually do:
    // call the injected runner with a real wallet context, and confirm
    // THAT reaches runNativePipeline with a closure that calls the
    // executor's buy().
    const injectedRunner =
      runPipelineForAllEligibleWalletsMock.mock.calls[0][2];
    const fakeWalletContext = {
      ownerWallet: "owner1",
      publicKey: "owner1",
      keypair: {} as any,
    };
    await injectedRunner(CANDIDATE.mint, 10, fakeWalletContext);

    expect(runNativePipelineMock).toHaveBeenCalledWith(
      CANDIDATE.mint,
      fakeWalletContext,
      expect.any(Function),
      "raydium-cpmm",
    );
    const executeNativeClosure = runNativePipelineMock.mock.calls[0][2];
    await executeNativeClosure(0.5, {
      ownerWallet: "owner1",
      keypair: {} as any,
    });
    expect(buyMock).toHaveBeenCalledWith(CANDIDATE, 0.5, {
      ownerWallet: "owner1",
      keypair: {},
    });
  });

  it("falls back to Jupiter if the whole native fan-out call throws unexpectedly", async () => {
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
    NATIVE_EXECUTOR_REGISTRY.set("raydium-cpmm", {
      poolType: "raydium-cpmm",
      buy: jest.fn(),
    });
    runPipelineForAllEligibleWalletsMock.mockImplementationOnce(() => {
      throw new Error("unexpected crash");
    });

    const result = await routeExecution(CANDIDATE, 10);
    expect(result.route).toBe("jupiter");
    expect(result.nativeFallbackReason).toMatch(/unexpected crash/);
  });
});
