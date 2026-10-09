// backend/src/services/execution/transaction/wsol.ts
//
// See /docs/native-swap-fund-safety-spec.md §1 for why this exists as its
// own file rather than being inlined into the CPMM executor: we do not
// trust raydium-sdk-v2's own native-SOL handling as the sole line of
// defense (see that doc's link to raydium-sdk-V2#107, a documented case of
// the SDK's own ATA/WSOL auto-handling throwing). Every instruction this
// file returns is meant to be prepended to a swap transaction explicitly,
// not left to an SDK internal we can't audit from here.
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * Instructions to fund a wallet's WSOL ATA with `lamports` of native SOL,
 * ready to be spent as the input side of a swap in the SAME transaction.
 * Order matters and must be preserved: create (idempotent, so a second call
 * against an already-existing ATA is a safe no-op) → transfer lamports in →
 * syncNative. Skipping syncNative is the single most common cause of a
 * swap that simulates fine but fails to send — see the spec's §1.
 */
export function buildWrapSolInstructions(
  owner: PublicKey,
  lamports: number | bigint,
): { instructions: TransactionInstruction[]; wsolAta: PublicKey } {
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner, // payer
      wsolAta,
      owner, // ATA owner
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: wsolAta,
      lamports,
    }),
    createSyncNativeInstruction(wsolAta),
  ];

  return { instructions, wsolAta };
}

/**
 * Instruction to unwrap whatever WSOL balance remains in the wallet's WSOL
 * ATA back to native SOL AND close the account, reclaiming its rent to
 * `owner` in the same instruction. Must be included in the sell
 * transaction itself — see the spec's §1 on why a separate follow-up
 * transaction is the wrong shape here (extra round trip, extra place for a
 * "did it land" gap).
 */
export function buildUnwrapSolInstruction(owner: PublicKey): {
  instruction: TransactionInstruction;
  wsolAta: PublicKey;
} {
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
  const instruction = createCloseAccountInstruction(
    wsolAta,
    owner, // lamports destination
    owner, // account owner/authority
  );
  return { instruction, wsolAta };
}

export { NATIVE_MINT };
