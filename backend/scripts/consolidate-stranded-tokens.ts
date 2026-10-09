#!/usr/bin/env -S npx tsx
// backend/scripts/consolidate-stranded-tokens.ts
//
// One-off recovery for the associatedOnly: false bug (see cpmm.ts's header
// comment) — the first live buy deposited proceeds into a self-created,
// non-canonical token account instead of the canonical ATA. This moves
// them into the canonical ATA with a plain SPL token transfer (no Raydium
// SDK involved at all — this is a well-understood, low-risk instruction),
// so the existing sell() path (which correctly targets the canonical ATA)
// can find and sell them normally afterward.
//
// Only useful for THIS specific stranded position. Going forward, the
// associatedOnly: true fix means new trades shouldn't create this
// situation again.
//
// Usage:
//   $env:CONSOLIDATE_CONFIRM = "YES-I-UNDERSTAND"
//   $env:MAINNET_DRYRUN_SECRET_KEY = ...
//   $env:CONSOLIDATE_MINT = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
//   $env:CONSOLIDATE_FROM = "ExiaDm5YK1eA5ssHDakRpEkBs6ekyentbL5J2WnvaMCm"
//   npx tsx scripts/consolidate-stranded-tokens.ts

import dotenv from "dotenv";
dotenv.config();

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";

function loadKeypair(): Keypair {
  const raw = (process.env.MAINNET_DRYRUN_SECRET_KEY ?? "").trim();
  if (!raw) throw new Error("MAINNET_DRYRUN_SECRET_KEY is not set");
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    /* fall through to base58 */
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function main() {
  if (process.env.CONSOLIDATE_CONFIRM !== "YES-I-UNDERSTAND") {
    throw new Error('Set CONSOLIDATE_CONFIRM="YES-I-UNDERSTAND" to proceed.');
  }
  const mint = process.env.CONSOLIDATE_MINT;
  const fromAccount = process.env.CONSOLIDATE_FROM;
  if (!mint || !fromAccount) {
    throw new Error("Set CONSOLIDATE_MINT and CONSOLIDATE_FROM.");
  }

  const keypair = loadKeypair();
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const mintPubkey = new PublicKey(mint);
  const source = new PublicKey(fromAccount);
  const destination = getAssociatedTokenAddressSync(
    mintPubkey,
    keypair.publicKey,
    false,
  );

  console.log(`Wallet:      ${keypair.publicKey.toBase58()}`);
  console.log(`Mint:        ${mint}`);
  console.log(`From (bad):  ${source.toBase58()}`);
  console.log(`To (ATA):    ${destination.toBase58()}\n`);

  const sourceInfo = await getAccount(connection, source);
  console.log(`Source balance: ${sourceInfo.amount.toString()} raw units`);
  if (sourceInfo.owner.toBase58() !== keypair.publicKey.toBase58()) {
    throw new Error(
      `Source account's owner (${sourceInfo.owner.toBase58()}) doesn't match this wallet — refusing to proceed.`,
    );
  }
  if (sourceInfo.amount <= 0n) {
    throw new Error(
      "Source account has zero balance — nothing to consolidate.",
    );
  }

  const destInfo = await getAccount(connection, destination);
  console.log(
    `Destination (canonical ATA) exists — current balance: ${destInfo.amount.toString()}`,
  );

  const ix = createTransferInstruction(
    source,
    destination,
    keypair.publicKey,
    sourceInfo.amount,
  );
  const tx = new Transaction().add(ix);

  console.log("\nSending consolidation transfer...\n");
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
    commitment: "confirmed",
  });
  console.log(`✅ Confirmed: ${sig}`);
  console.log(`Solscan: https://solscan.io/tx/${sig}`);

  const destAfter = await getAccount(connection, destination);
  console.log(`\nDestination balance after: ${destAfter.amount.toString()}`);
}

main().catch((err) => {
  console.error("\n💥 Crashed:", err);
  process.exit(1);
});
