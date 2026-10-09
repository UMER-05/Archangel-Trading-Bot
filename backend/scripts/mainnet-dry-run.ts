#!/usr/bin/env -S npx tsx
// backend/scripts/mainnet-dry-run.ts
//
// Stage B of the devnet smoke test described in
// docs/devnet-smoke-test-guide.md. Devnet (Stage A,
// scripts/devnet-smoke-test.ts) can't exercise an actual Raydium swap
// because real, liquid CPMM pools don't reliably exist there. This script
// covers that gap the only honest way available: run the real buy() logic
// — real pool fetch, real CurveCalculator quote, real raydium-sdk-v2
// instruction building — against a REAL mainnet pool, but forced into
// simulate-only mode so no transaction is ever actually sent and no funds
// ever move.
//
// SAFETY: USE_REAL_SWAP is force-set to "false" below, before any other
// module is imported, overriding whatever is in your actual environment.
// This cannot be bypassed by an env var — that's deliberate. If you ever
// want to graduate this into an actual small real-money test, that should
// be a conscious, separate, manually-reviewed action — not a flag flip on
// this script.
//
// Usage:
//   MAINNET_DRYRUN_SECRET_KEY='[...]' \
//   MAINNET_DRYRUN_POOL_ADDRESS=<pool pubkey> \
//   MAINNET_DRYRUN_MINT=<token mint> \
//   MAINNET_DRYRUN_DEX=raydium-cpmm \
//   npx tsx scripts/mainnet-dry-run.ts
//
// The wallet needs a small SOL balance (~0.01 SOL) — simulateTransaction
// still checks fee-payer solvency even though nothing is actually sent.

process.env.USE_REAL_SWAP = "false"; // See header comment — not overridable via the environment.

import dotenv from "dotenv";
dotenv.config();
// Loaded after the USE_REAL_SWAP override above, same ordering reasoning
// as first-real-buy.ts. Without this, SOLANA_RPC_URL was silently empty
// here too, meaning this script's simulation ran against the public
// rate-limited RPC rather than whatever provider is actually configured —
// didn't cause a wrong pass/fail here since it only ever simulated, but
// worth fixing for consistency and because a flaky/lagging public RPC
// could plausibly cause a spurious simulation failure on a slower day.

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { cpmmExecutor } from "../src/services/execution/raydium/cpmm.js";
import type { CandidateMint } from "../src/services/tokenExtraction.service.js";

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
  const poolAddress = process.env.MAINNET_DRYRUN_POOL_ADDRESS;
  const mint = process.env.MAINNET_DRYRUN_MINT;
  const dex = process.env.MAINNET_DRYRUN_DEX ?? "raydium-cpmm";
  const amountSol = Number(process.env.MAINNET_DRYRUN_AMOUNT_SOL ?? "0.01");

  if (!poolAddress || !mint) {
    throw new Error(
      "Set MAINNET_DRYRUN_POOL_ADDRESS and MAINNET_DRYRUN_MINT to a REAL, currently-liquid mainnet Raydium CPMM pool/mint pair.",
    );
  }

  const keypair = loadKeypair();
  console.log(`Mainnet dry run (USE_REAL_SWAP forced false — simulate only)`);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Pool:   ${poolAddress}`);
  console.log(`Mint:   ${mint}`);
  console.log(`Dex:    ${dex}`);
  console.log(`Amount: ${amountSol} SOL\n`);

  const candidate: CandidateMint = {
    mint,
    poolAddress,
    dex,
    poolCreatedAt: new Date(),
  };

  const result = await cpmmExecutor.buy(candidate, amountSol, {
    ownerWallet: keypair.publicKey.toBase58(),
    keypair,
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  if (!result.success) {
    console.error(
      "\n❌ Dry run reported failure — this means the real SDK integration itself has a problem (wrong pool state read, bad instruction construction, etc.), not just a network hiccup, since nothing was actually sent.",
    );
    process.exit(1);
  }
  console.log(
    "\n✅ Simulation succeeded — the pool fetch, quote, and instruction-building path all ran against real on-chain data without error.",
  );
}

main().catch((err) => {
  console.error("\n💥 Dry run crashed:", err);
  process.exit(1);
});
