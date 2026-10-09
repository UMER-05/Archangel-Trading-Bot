#!/usr/bin/env -S npx tsx
// backend/scripts/first-real-sell-router-test.ts
//
// Sell-side counterpart to first-real-router-test.ts. Calls
// sellExecutionRouterService.routeSell() directly — the actual function
// monitor.service.ts's three exit call sites use in production — proving
// the claim guard, native/Jupiter decision, and executor call all work
// together for real, for the first time. Everything sell-related tested
// before this called cpmmExecutor.sell() directly, bypassing this router
// entirely.
//
// Lower blast radius than the buy-router test: routeSell() only ever acts
// on the exact (wallet, mint) pair passed in — no live eligible-wallet
// fan-out involved — so there's no "other users might get swept in"
// concern here the way there was for buys.
//
// Usage:
//   $env:SELL_ROUTER_TEST_CONFIRM = "YES-I-UNDERSTAND"
//   $env:MAINNET_DRYRUN_SECRET_KEY = ...
//   $env:MAINNET_DRYRUN_MINT = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
//   npx tsx scripts/first-real-sell-router-test.ts

process.env.USE_REAL_SWAP = "true";
process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED = "true";
process.env.RAYDIUM_CPMM_EXECUTOR_ENABLED = "true";

import dotenv from "dotenv";
dotenv.config();

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import sellExecutionRouterService from "../src/services/execution/sellExecutionRouter.service.js";
import { registerNativeExecutors } from "../src/services/execution/registerNativeExecutors.js";

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
): Promise<bigint> {
  const resp = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint },
    "confirmed",
  );
  return resp.value.reduce(
    (sum, { account }) =>
      sum + BigInt(account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}

async function printBalances(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  label: string,
) {
  const sol = await connection.getBalance(owner, "confirmed");
  const token = await getTokenBalanceRaw(connection, owner, mint);
  console.log(`${label} SOL balance: ${sol / 1e9} SOL`);
  console.log(`${label} token balance (raw): ${token.toString()}`);
}

async function main() {
  if (process.env.SELL_ROUTER_TEST_CONFIRM !== "YES-I-UNDERSTAND") {
    throw new Error(
      'Set SELL_ROUTER_TEST_CONFIRM="YES-I-UNDERSTAND" to proceed.',
    );
  }
  const mint = process.env.MAINNET_DRYRUN_MINT;
  if (!mint) throw new Error("Set MAINNET_DRYRUN_MINT.");

  const keypair = loadKeypair();
  const wallet = keypair.publicKey.toBase58();
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const mintPubkey = new PublicKey(mint);

  console.log("=".repeat(60));
  console.log("FIRST REAL SELL-ROUTER TEST — LIVE FUNDS");
  console.log("=".repeat(60));
  console.log(`Wallet: ${wallet}\n`);

  registerNativeExecutors();

  await printBalances(connection, keypair.publicKey, mintPubkey, "BEFORE");
  const balanceRaw = await getTokenBalanceRaw(
    connection,
    keypair.publicKey,
    mintPubkey,
  );
  if (balanceRaw <= 0n) {
    throw new Error("Nothing to sell — token balance is zero.");
  }
  if (balanceRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "Balance too large to safely pass as a JS number to the router — not expected for a test position.",
    );
  }

  console.log(`\nSelling raw amount: ${balanceRaw.toString()}\n`);

  const result = await sellExecutionRouterService.routeSell({
    tokenMint: mint,
    wallet,
    amountBaseUnits: Number(balanceRaw),
    slippageBps: 200, // 2%, matching this project's other default slippage settings
    signer: keypair,
    useRealSwap: true,
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  await printBalances(connection, keypair.publicKey, mintPubkey, "AFTER");

  if (result.signature) {
    console.log(`\nSolscan: https://solscan.io/tx/${result.signature}`);
  }

  if (result.route === "skipped") {
    console.error(
      "\n⚠️  Skipped — a sell for this wallet/position was already in flight (claim guard). Not a failure, but nothing happened.",
    );
    process.exit(1);
  }
  if (!result.success) {
    console.error("\n❌ Sell failed:", result.error);
    process.exit(1);
  }
  console.log(
    `\n✅ Sell router → ${result.route} → executor, all real, all confirmed.`,
  );
}

main().catch((err) => {
  console.error("\n💥 Crashed:", err);
  process.exit(1);
});
