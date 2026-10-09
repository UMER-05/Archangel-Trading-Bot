// backend/src/services/execution/transaction/ata.ts
//
// See /docs/native-swap-fund-safety-spec.md §2. One function, used for
// every mint an executor needs an account for (the output token on a buy,
// the WSOL account via wsol.ts) — always the idempotent instruction
// variant, never the plain one, so a defensive retry against a wallet that
// already has the account (see §2's pass/fail test) never fails with
// "account already in use."
import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export function buildEnsureAtaInstruction(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): { instruction: TransactionInstruction; ata: PublicKey } {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    tokenProgramId,
  );
  const instruction = createAssociatedTokenAccountIdempotentInstruction(
    owner, // payer
    ata,
    owner, // ATA owner
    mint,
    tokenProgramId,
  );
  return { instruction, ata };
}
