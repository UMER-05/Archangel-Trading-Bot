jest.mock("../services/execution/raydium/cpmm.js", () => ({
  __esModule: true,
  cpmmExecutor: { poolType: "raydium-cpmm", buy: jest.fn() },
}));

import { registerNativeExecutors } from "../services/execution/registerNativeExecutors.js";
import { NATIVE_EXECUTOR_REGISTRY } from "../services/execution/nativeExecutor.types.js";

describe("registerNativeExecutors", () => {
  const ORIGINAL = process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED;

  beforeEach(() => {
    NATIVE_EXECUTOR_REGISTRY.clear();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED;
    } else {
      process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED = ORIGINAL;
    }
    NATIVE_EXECUTOR_REGISTRY.clear();
  });

  it("does not register the CPMM executor when its flag is unset", () => {
    delete process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED;
    registerNativeExecutors();
    expect(NATIVE_EXECUTOR_REGISTRY.has("raydium-cpmm")).toBe(false);
  });

  it("registers the CPMM executor only when its flag is explicitly true", () => {
    process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED = "true";
    registerNativeExecutors();
    expect(NATIVE_EXECUTOR_REGISTRY.has("raydium-cpmm")).toBe(true);
  });
});
