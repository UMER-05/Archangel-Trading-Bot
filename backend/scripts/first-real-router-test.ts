#!/usr/bin/env -S npx tsx
// backend/scripts/first-real-router-test.ts
//
// Proves executionRouter.service.ts's actual production entry point —
// routeExecution() — with real money, for the FIRST time. Everything
// before this validated cpmmExecutor.buy()/sell() directly, bypassing the
// router entirely. This is different in kind, not just degree: routeExecution()
// calls getEligibleWallets(), which returns EVERY wallet with auto-trade
// currently enabled — on a multi-user bot, that can mean real buys for
// real users, not just the developer's own wallet.
//
// SAFETY GATE (the important one): before doing anything real, this
// fetches the live eligible-wallet list and HARD-FAILS unless it contains
// EXACTLY the one wallet you specify — not "trust that nobody else has
// auto-trade on," an actual check against the live DB at the moment this
// runs. If anyone else is eligible, this refuses to proceed rather than
// risk trading on their behalf with an unproven code path.
//
// This also seeds a TokenState DB record for the test mint (launch market
// cap + pool-created-at) — the fan-out's own eligibility gates
// (launchMetricsWithinLimits, launchAgeWithinWindow) need this to exist,
// since our test mint was never discovered through the real pipeline.
// This IS a real write to your production database — the token will show
// up in normal TokenState queries afterward, same as any real discovery.
//
// Usage:
//   $env:ROUTER_TEST_CONFIRM = "YES-I-UNDERSTAND"
//   $env:MAINNET_DRYRUN_SECRET_KEY = ...
//   $env:MAINNET_DRYRUN_POOL_ADDRESS = "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp"
//   $env:MAINNET_DRYRUN_MINT = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
//   $env:MAINNET_DRYRUN_DEX = "raydium-cpmm"
//   npx tsx scripts/first-real-router-test.ts

process.env.USE_REAL_SWAP = "true";
process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED = "true";
// All three forced here, in the script, NOT read from .env — your actual
// .env should stay however it is for production; this script's behavior
// doesn't depend on it.

import dotenv from "dotenv";
dotenv.config();

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import executionRouterService from "../src/services/execution/executionRouter.service.js";
import { registerNativeExecutors } from "../src/services/execution/registerNativeExecutors.js";
import multiUserExecutionService from "../src/services/multiUserExecution.service.js";
import dbService from "../src/services/db.service.js";
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

async function printBalances(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  label: string,
) {
  const sol = await connection.getBalance(owner, "confirmed");
  console.log(`${label} SOL balance: ${sol / 1e9} SOL`);
  const resp = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint },
    "confirmed",
  );
  const total = resp.value.reduce(
    (sum, { account }) =>
      sum + BigInt(account.data.parsed.info.tokenAmount.amount),
    0n,
  );
  console.log(
    `${label} token balance (raw, summed across ${resp.value.length} account(s)): ${total.toString()}`,
  );
}

async function main() {
  if (process.env.ROUTER_TEST_CONFIRM !== "YES-I-UNDERSTAND") {
    throw new Error('Set ROUTER_TEST_CONFIRM="YES-I-UNDERSTAND" to proceed.');
  }

  const poolAddress = process.env.MAINNET_DRYRUN_POOL_ADDRESS;
  const mint = process.env.MAINNET_DRYRUN_MINT;
  const dex = process.env.MAINNET_DRYRUN_DEX ?? "raydium-cpmm";
  if (!poolAddress || !mint) {
    throw new Error("Set MAINNET_DRYRUN_POOL_ADDRESS and MAINNET_DRYRUN_MINT.");
  }

  const keypair = loadKeypair();
  const expectedWallet = keypair.publicKey.toBase58();
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const mintPubkey = new PublicKey(mint);

  console.log("=".repeat(60));
  console.log("FIRST REAL ROUTER/PIPELINE TEST — LIVE FUNDS, REAL FAN-OUT");
  console.log("=".repeat(60));
  console.log(`Wallet: ${expectedWallet}\n`);

  // THE safety gate. Not a formality — an actual check against the live
  // DB, run fresh every time this script executes.
  console.log("Checking live eligible-wallet list...");
  const eligible = await multiUserExecutionService.getEligibleWallets();
  const eligibleAddresses = eligible.map((w) => w.ownerWallet);
  console.log(
    `Eligible wallets right now: ${JSON.stringify(eligibleAddresses)}`,
  );
  const unexpected = eligibleAddresses.filter((w) => w !== expectedWallet);
  if (unexpected.length > 0) {
    throw new Error(
      `SAFETY GATE TRIPPED: ${unexpected.length} wallet(s) other than yours are currently ` +
        `eligible for auto-trade: ${JSON.stringify(unexpected)}. Refusing to run — this ` +
        `would fan a real, first-ever router-level native buy out to them too. ` +
        `Disable auto-trade for these wallets first, or don't run this script yet.`,
    );
  }
  if (!eligibleAddresses.includes(expectedWallet)) {
    throw new Error(
      `Your own wallet (${expectedWallet}) isn't in the eligible list — check that ` +
        `auto-trade is enabled for it in Global Trade Settings, or this test won't buy anything.`,
    );
  }
  console.log("✅ Only your wallet is eligible — safe to proceed.\n");

  registerNativeExecutors();

  // Seed a TokenState record so the fan-out's own eligibility gates
  // (market cap, launch age) don't reject this wallet before native
  // execution is ever reached — see header comment. Values chosen to
  // comfortably clear the default 3 SOL minimum and any reasonable
  // launch-age window, given this is a long-established, real pool.
  console.log("Seeding TokenState for eligibility gates...");
  await dbService.upsertTokenState({
    mint,
    symbol: "TEST",
    name: "Router Test Token",
    state: "TRADABLE",
    source: "other",
    poolAddress,
    dex,
    poolCreatedAt: new Date("2024-03-01"),
    launchMarketCapSOL: 500,
    detectedAt: new Date(),
  });
  // upsertTokenState routes launchMarketCapSOL AND poolCreatedAt through
  // MongoDB's $setOnInsert, which only applies on a document's first-ever
  // insert — this mint's TokenState row already existed (confirmed by the
  // launch-market-cap gate rejection on the previous run), so BOTH were
  // silently skipped. setLaunchMarketCapIfUnset covers the first field;
  // there's no equivalent helper for poolCreatedAt, so this does a direct
  // raw update instead — appropriate for one-off test setup, not
  // something to do in production code, which is why it's here in the
  // script rather than added as a new dbService function for a single
  // test's sake.
  await dbService.setLaunchMarketCapIfUnset(mint, 500);
  {
    const { MongoClient } = await import("mongodb");
    const rawClient = new MongoClient(process.env.MONGO_URI || "");
    await rawClient.connect();
    await rawClient
      .db(process.env.MONGO_DB_NAME || "archangel")
      .collection("tokenStates")
      .updateOne({ mint }, { $set: { poolCreatedAt: new Date("2024-03-01") } });
    await rawClient.close();
  }

  await printBalances(connection, keypair.publicKey, mintPubkey, "BEFORE");

  const candidate: CandidateMint = {
    mint,
    poolAddress,
    dex,
    poolCreatedAt: new Date("2024-03-01"),
  };

  console.log(
    "\nCalling executionRouterService.routeExecution() for real...\n",
  );
  const result = await executionRouterService.routeExecution(candidate, 500);

  console.log("\nRoute chosen:", result.route);
  if (result.nativeFallbackReason) {
    console.log("Native fallback reason:", result.nativeFallbackReason);
  }
  console.log(
    "Fan-out results:",
    JSON.stringify(result.fanOutResults, null, 2),
  );

  await printBalances(connection, keypair.publicKey, mintPubkey, "AFTER");

  if (result.route !== "raydium-native") {
    console.error(
      "\n⚠️  Did NOT route to native — fell back to Jupiter. Read nativeFallbackReason above.",
    );
    process.exit(1);
  }
  const ownResult = result.fanOutResults.find(
    (r) => r.ownerWallet === expectedWallet,
  );
  if (!ownResult?.result.success) {
    console.error(
      "\n❌ Native route was chosen, but your wallet's own pipeline result was a failure:",
      ownResult?.result.reason,
    );
    process.exit(1);
  }
  console.log(
    "\n✅ Router → native pipeline → executor, all real, all confirmed.",
  );
}

main().catch((err) => {
  console.error("\n💥 Crashed:", err);
  process.exit(1);
});
