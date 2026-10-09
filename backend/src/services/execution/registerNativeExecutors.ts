// backend/src/services/execution/registerNativeExecutors.ts
//
// The only place anything is ever added to NATIVE_EXECUTOR_REGISTRY. Called
// once at server startup (see index.ts) — deliberately NOT done as a
// module-level side effect in cpmm.ts itself, so importing that file (e.g.
// from a test) never has the side effect of making it live.
//
// Two independent flags gate real execution, both must be true:
//   RAYDIUM_NATIVE_EXECUTION_ENABLED   — executionRouter.service.ts's own
//                                        flag, the overall on/off switch.
//   RAYDIUM_CPMM_EXECUTOR_ENABLED      — this executor specifically. Kept
//                                        separate so CPMM can be proven out
//                                        on its own before AMM V4/CLMM
//                                        executors are added here later,
//                                        each behind their own flag.
import { getLogger } from "../../utils/logger.js";
import { NATIVE_EXECUTOR_REGISTRY } from "./nativeExecutor.types.js";
import { cpmmExecutor } from "./raydium/cpmm.js";

const LOG = getLogger("native-executors");

export function registerNativeExecutors(): void {
  if (process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED === "true") {
    NATIVE_EXECUTOR_REGISTRY.set(cpmmExecutor.poolType, cpmmExecutor);
    LOG.warn(
      "🧪 Raydium CPMM native executor registered — see " +
        "docs/native-swap-fund-safety-spec.md before running this against " +
        "real funds. This has no effect unless " +
        "RAYDIUM_NATIVE_EXECUTION_ENABLED is also true.",
    );
  } else {
    LOG.info(
      "Raydium CPMM native executor not registered (RAYDIUM_CPMM_EXECUTOR_ENABLED unset) — all candidates route to Jupiter",
    );
  }
}
