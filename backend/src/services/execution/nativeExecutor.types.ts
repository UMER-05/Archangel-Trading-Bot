// backend/src/services/execution/nativeExecutor.types.ts
//
// The contract a per-pool-type native executor (raydium/cpmm.ts,
// raydium/ammV4.ts, raydium/clmm.ts — none of which exist yet) must
// implement to be routable by executionRouter.service.ts. Defining this now
// — before any executor exists — is deliberate: it's what lets the router,
// the feature flag, and the fallback-to-Jupiter path all be built, wired in,
// and exercised today, with the registry simply empty until a real executor
// is dropped in behind it. The router's behavior with an empty registry is
// itself the correct default: every candidate falls back to Jupiter,
// because there is nothing registered to route to.
import type { CandidateMint } from "../tokenExtraction.service.js";
import type { RaydiumPoolType } from "./raydiumProgramIds.js";
import type { Keypair } from "@solana/web3.js";
import type BN from "bn.js";

export interface NativeExecutionResult {
  success: boolean;
  signature?: string;
  actualPrice?: number;
  tokensReceived?: number;
  tokensSold?: number;
  amountSol?: number;
  reason?: string;
}

export interface NativeExecutorContext {
  ownerWallet: string;
  // The wallet that will sign the transaction. Callers must guarantee this
  // matches ownerWallet — same custody-safety rule jupiter.service.ts
  // already enforces (a mismatched signer either fails on-chain or, worse,
  // moves a different wallet's funds).
  keypair: Keypair;
}

export interface NativeExecutor {
  poolType: RaydiumPoolType;
  buy(
    candidate: CandidateMint,
    amountSol: number,
    ctx: NativeExecutorContext,
  ): Promise<NativeExecutionResult>;
  // Optional so a future AMM V4/CLMM executor can register a buy-only
  // implementation first, same staged rollout as CPMM itself. CPMM's own
  // executor (raydium/cpmm.ts) implements both from the start — see
  // positionExitCoordinator.service.ts for the claim guard any caller of
  // this must wrap around it.
  sell?(
    candidate: CandidateMint,
    tokenAmountRaw: BN,
    ctx: NativeExecutorContext,
  ): Promise<NativeExecutionResult>;
}

// Deliberately empty. A future executor registers itself with:
//   NATIVE_EXECUTOR_REGISTRY.set("raydium-cpmm", cpmmExecutor);
// Nothing in this file should ever pre-populate an entry — that's the job
// of the executor's own module, once it exists and has been reviewed
// specifically for the fund-safety concerns in the swap-engine spec (WSOL
// handling, ATA-atomic-with-swap, on-chain minimumAmountOut, compute unit
// budgeting) rather than added here as a placeholder.
export const NATIVE_EXECUTOR_REGISTRY = new Map<
  RaydiumPoolType,
  NativeExecutor
>();
