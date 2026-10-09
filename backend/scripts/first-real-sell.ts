#!/usr/bin/env -S npx tsx
// backend/scripts/first-real-sell.ts
//
// Counterpart to first-real-buy.ts — same reasoning applies: calls
// cpmmExecutor.sell() directly, bypassing sellExecutionRouter.service.ts
// and monitor.service.ts entirely, so this can be proven out with real
// funds before trusting the router integration with them. See
// first-real-buy.ts's header for the full reasoning; not repeated here.
//
// Sells the position bought by first-real-buy.ts — WSOL unwrap included
// (see docs/native-swap-fund-safety-spec.md §1), so a successful run
// should leave your wallet with more native SOL than before, not a
// dangling WSOL account.
//
// SAFETY RAILS:
//   1. Refuses to run unless FIRST_REAL_SELL_CONFIRM=YES-I-UNDERSTAND is
//      set exactly.
//   2. Sells your FULL current balance of the token by default (reading
//      it live from chain) — set FIRST_REAL_SELL_AMOUNT_TOKENS to sell a
//      specific (smaller) amount instead.
//   3. Prints wallet SOL balance and token balance BEFORE and AFTER.
//
// Usage:
//   $env:FIRST_REAL_SELL_CONFIRM = "YES-I-UNDERSTAND"
//   $env:MAINNET_DRYRUN_SECRET_KEY = ...   (same wallet as the buy)
//   $env:MAINNET_DRYRUN_POOL_ADDRESS = "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp"
//   $env:MAINNET_DRYRUN_MINT = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
//   $env:MAINNET_DRYRUN_DEX = "raydium-cpmm"
//   npx tsx scripts/first-real-sell.ts

process.env.USE_REAL_SWAP = "true"; // Same as first-real-buy.ts — hardcoded here, not left to .env.

import dotenv from "dotenv";
dotenv.config();
// See first-real-buy.ts's identical comment — without this,
// SOLANA_RPC_URL was silently empty here, meaning both this script's own
// balance checks AND cpmmExecutor.sell()'s internal getConnection() call
// were hitting the public rate-limited RPC, not your configured provider.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import BN from "bn.js";
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

async function getTokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<{ raw: BN; ui: string }> {
  // Real bug found via the associatedOnly issue: a wallet can hold MORE
  // THAN ONE token account for the same mint (the canonical ATA, plus a
  // stray non-standard one) — this used to read only resp.value[0], which
  // silently missed a nonzero balance sitting in resp.value[1]. Sums
  // across every matching account instead, so this is correct regardless
  // of how many accounts exist for this mint.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const resp = await connection.getParsedTokenAccountsByOwner(
      owner,
      { mint },
      "confirmed",
    );
    if (resp.value.length > 0) {
      let total = new BN(0);
      let decimals = 0;
      for (const { account } of resp.value) {
        const info = account.data.parsed.info;
        total = total.add(new BN(info.tokenAmount.amount));
        decimals = info.tokenAmount.decimals;
      }
      if (total.gtn(0) || attempt === 5) {
        const ui = (Number(total.toString()) / 10 ** decimals).toString();
        return { raw: total, ui };
      }
    } else if (attempt === 5) {
      throw new Error(
        "No token account found for this mint after 5 retries — nothing to sell?",
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Unreachable");
}

async function printSol(
  connection: Connection,
  owner: PublicKey,
  label: string,
) {
  const sol = await connection.getBalance(owner, "confirmed");
  console.log(`${label} SOL balance: ${sol / 1e9} SOL`);
}

async function main() {
  if (process.env.FIRST_REAL_SELL_CONFIRM !== "YES-I-UNDERSTAND") {
    throw new Error(
      'Refusing to run. Set FIRST_REAL_SELL_CONFIRM="YES-I-UNDERSTAND" (exactly) to proceed.',
    );
  }

  const poolAddress = process.env.MAINNET_DRYRUN_POOL_ADDRESS;
  const mint = process.env.MAINNET_DRYRUN_MINT;
  const dex = process.env.MAINNET_DRYRUN_DEX ?? "raydium-cpmm";
  if (!poolAddress || !mint) {
    throw new Error("Set MAINNET_DRYRUN_POOL_ADDRESS and MAINNET_DRYRUN_MINT.");
  }

  const keypair = loadKeypair();
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const mintPubkey = new PublicKey(mint);

  console.log("=".repeat(60));
  console.log("FIRST REAL SELL — LIVE FUNDS");
  console.log("=".repeat(60));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Pool:   ${poolAddress}`);
  console.log(`Mint:   ${mint}\n`);

  await printSol(connection, keypair.publicKey, "BEFORE");
  const balanceBefore = await getTokenBalanceRaw(
    connection,
    keypair.publicKey,
    mintPubkey,
  );
  console.log(`BEFORE token balance: ${balanceBefore.ui}`);

  const sellAmountRaw = process.env.FIRST_REAL_SELL_AMOUNT_TOKENS
    ? new BN(process.env.FIRST_REAL_SELL_AMOUNT_TOKENS)
    : balanceBefore.raw;

  if (sellAmountRaw.lten(0)) {
    throw new Error("Nothing to sell — token balance is zero.");
  }
  console.log(`Selling raw amount: ${sellAmountRaw.toString()}\n`);

  const candidate: CandidateMint = {
    mint,
    poolAddress,
    dex,
    poolCreatedAt: new Date(),
  };

  console.log("Sending...\n");
  if (!cpmmExecutor.sell) {
    // Purely a type-level guard — cpmmExecutor always implements sell()
    // in practice, but the NativeExecutor interface marks it optional
    // for future executors that might not, so TypeScript needs this
    // checked explicitly before the call below.
    throw new Error(
      "cpmmExecutor.sell is not implemented — this should never happen",
    );
  }
  const result = await cpmmExecutor.sell(candidate, sellAmountRaw, {
    ownerWallet: keypair.publicKey.toBase58(),
    keypair,
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  await printSol(connection, keypair.publicKey, "AFTER");
  try {
    const after = await getTokenBalanceRaw(
      connection,
      keypair.publicKey,
      mintPubkey,
    );
    console.log(`AFTER token balance: ${after.ui}`);
  } catch {
    console.log("AFTER token balance: 0 (or account closed)");
  }

  if (result.signature && !result.signature.startsWith("sim-")) {
    console.log(`\nSolscan: https://solscan.io/tx/${result.signature}`);
  }

  if (!result.success) {
    console.error(
      "\n❌ Sell failed or outcome unknown — read the `reason` field above carefully.",
    );
    process.exit(1);
  }
  console.log("\n✅ First real sell confirmed.");
}

main().catch((err) => {
  console.error("\n💥 Crashed:", err);
  process.exit(1);
});
