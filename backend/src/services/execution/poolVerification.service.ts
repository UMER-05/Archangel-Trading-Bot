// backend/src/services/execution/poolVerification.service.ts
//
// Development-order Step 4 ("Does this actually correspond to a valid
// Raydium pool?") — currently the only thing standing between a candidate
// and the (still-unbuilt) native swap engine is Jupiter's own tradeability
// check, which confirms a route exists but says nothing about whether the
// pool account QuickNode handed us is genuinely owned by the Raydium
// program its `dex` field claims. This module closes that gap.
//
// This is a narrow, deliberately conservative check: it confirms the pool
// account exists on-chain and is owned by the exact pinned program ID for
// its claimed pool type (see raydiumProgramIds.ts). It does NOT deserialize
// the pool's own layout (reserves, mints, tick arrays, etc.) — that belongs
// to whichever module actually reads pool state for pricing/execution
// (market/poolState.ts, still to be built). Owner-check first, layout
// parsing later, because a pool whose owner doesn't match isn't safe to
// hand to a type-specific parser at all — parsing it anyway is exactly the
// "doesn't fail loudly, executes against the wrong accounts" failure mode
// this whole verification step exists to prevent.
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../solana.service.js";
import { getLogger } from "../../utils/logger.js";
import {
  RAYDIUM_PROGRAM_IDS,
  RaydiumPoolType,
  toCanonicalRaydiumPoolType,
} from "./raydiumProgramIds.js";

const LOG = getLogger("pool-verification");

export interface PoolVerificationResult {
  verified: boolean;
  poolType: RaydiumPoolType | null;
  reason?: string;
}

/**
 * Confirms `poolAddress` is a real on-chain account owned by the pinned
 * Raydium program for the pool type the candidate claims. Every failure
 * path returns `verified: false` with a reason — there is no partial-trust
 * result. Callers (the execution router) treat an unverified pool as
 * ineligible for native execution and fall back to the existing Jupiter
 * path; they do NOT retry the parse or guess.
 */
export async function verifyRaydiumPool(
  dex: string,
  poolAddress: string,
): Promise<PoolVerificationResult> {
  const poolType = toCanonicalRaydiumPoolType(dex);
  if (!poolType) {
    return {
      verified: false,
      poolType: null,
      reason: `Unrecognized/unsupported dex "${dex}" — no pinned program ID`,
    };
  }

  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(poolAddress);
  } catch {
    return {
      verified: false,
      poolType,
      reason: "poolAddress is not a valid base58 public key",
    };
  }

  const expectedOwner = RAYDIUM_PROGRAM_IDS[poolType];
  const conn = getConnection();
  const accountInfo = await conn.getAccountInfo(pubkey, "confirmed");

  if (!accountInfo) {
    return {
      verified: false,
      poolType,
      reason: "Pool account does not exist on-chain",
    };
  }

  const actualOwner = accountInfo.owner.toBase58();
  if (actualOwner !== expectedOwner) {
    // This is the case worth logging loudly: it means either QuickNode's
    // Stream Function mislabeled the dex, the pool was closed/reinitialized
    // under a different program, or the payload is spoofed/malformed. Any
    // of those is a reason to hard-fail, never a reason to guess.
    LOG.warn(
      { poolAddress, claimedType: poolType, expectedOwner, actualOwner },
      "Pool owner mismatch — claimed pool type does not match on-chain program",
    );
    return {
      verified: false,
      poolType,
      reason: `Owner mismatch: expected ${expectedOwner}, got ${actualOwner}`,
    };
  }

  if (accountInfo.data.length === 0) {
    return {
      verified: false,
      poolType,
      reason: "Pool account has no data",
    };
  }

  return { verified: true, poolType };
}
