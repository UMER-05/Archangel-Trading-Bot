#!/usr/bin/env -S npx tsx
// backend/scripts/first-real-buy.ts
//
// The first real, small, watched trade — deliberately NOT routed through
// executionRouter.service.ts or the validationPipeline fan-out. Those were
// rewritten this session and have only ever been exercised by mocked unit
// tests. Stacking an unproven router on top of an unproven executor at the
// moment real money moves is exactly the wrong order — this calls
// cpmmExecutor.buy() directly, the same shape as mainnet-dry-run.ts, but
// with sending actually turned on. The router gets its own real-money
// validation AFTER this passes, as a separate deliberate step.
//
// Consequence worth knowing: this bypasses candidatePipeline's claim
// guard, the wallet mutex, and position-metadata recording. The bought
// position will NOT show up in monitor.service.ts's exit-monitoring loop
// or your dashboard — because nothing here is aware of it. You are
// responsible for tracking and eventually selling this position manually
// (scripts/first-real-sell.ts is the counterpart) until the router path
// is separately validated and flipped on.
//
// SAFETY RAILS (all deliberate, do not bypass casually):
//   1. Refuses to run at all unless FIRST_REAL_BUY_CONFIRM=YES-I-UNDERSTAND
//      is set exactly — typing this out is the point, not a formality.
//   2. Hard ceiling: refuses to trade more than 0.05 SOL unless
//      FIRST_REAL_BUY_OVERRIDE_CEILING=true is also set. This exists
//      specifically to catch a typo (0.5 instead of 0.05).
//   3. Prints wallet SOL balance and token balance BEFORE and AFTER, so a
//      partial/unexpected outcome is visible immediately, not discovered
//      later.
//
// Usage:
//   $env:FIRST_REAL_BUY_CONFIRM = "YES-I-UNDERSTAND"
//   $env:MAINNET_DRYRUN_SECRET_KEY = ...   (reused — same wallet, same var name as Stage B)
//   $env:MAINNET_DRYRUN_POOL_ADDRESS = "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp"
//   $env:MAINNET_DRYRUN_MINT = "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
//   $env:MAINNET_DRYRUN_DEX = "raydium-cpmm"
//   $env:FIRST_REAL_BUY_AMOUNT_SOL = "0.01"
//   npx tsx scripts/first-real-buy.ts

process.env.USE_REAL_SWAP = "true"; // This script's entire purpose — real sending, deliberately hardcoded here rather than left to .env.

import dotenv from "dotenv";
dotenv.config();
// Loaded AFTER forcing USE_REAL_SWAP above, so .env can't override that —
// but BEFORE any of this script's own connection/keypair logic runs,
// which needs SOLANA_RPC_URL (and anything else your bot's real .env
// configures) to actually be present. Without this, process.env.SOLANA_RPC_URL
// was silently empty in this standalone script, meaning both the balance
// checks below AND cpmmExecutor.buy()'s own internal getConnection() call
// were falling back to the public, rate-limited api.mainnet-beta.solana.com
// endpoint — not whatever RPC provider is actually configured for this bot.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { cpmmExecutor } from "../src/services/execution/raydium/cpmm.js";
import type { CandidateMint } from "../src/services/tokenExtraction.service.js";

const HARD_CEILING_SOL = 0.05;

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

  // Real bug found via the associatedOnly issue: a wallet can hold more
  // than one token account for the same mint — this used to read only
  // the first result from getParsedTokenAccountsByOwner, silently missing
  // a nonzero balance in a second account. Sums across every matching
  // account instead.
  let lastAmount = "0";
  let sawAccount = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const resp = await connection.getParsedTokenAccountsByOwner(
      owner,
      { mint },
      "confirmed",
    );
    if (resp.value.length > 0) {
      sawAccount = true;
      let totalRaw = 0n;
      let decimals = 0;
      for (const { account } of resp.value) {
        const info = account.data.parsed.info;
        totalRaw += BigInt(info.tokenAmount.amount);
        decimals = info.tokenAmount.decimals;
      }
      if (totalRaw > 0n) {
        lastAmount = (Number(totalRaw) / 10 ** decimals).toString();
        console.log(
          `${label} token balance: ${lastAmount} (across ${resp.value.length} account(s))`,
        );
        return;
      }
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 1500));
  }
  if (sawAccount) {
    console.log(
      `${label} token balance: ${lastAmount} (read as zero after 5 retries — this may still be RPC lag, verify on Solscan before trusting this number)`,
    );
  } else {
    console.log(
      `${label} token balance: (no token account found after 5 retries)`,
    );
  }
}

async function main() {
  if (process.env.FIRST_REAL_BUY_CONFIRM !== "YES-I-UNDERSTAND") {
    throw new Error(
      'Refusing to run. Set FIRST_REAL_BUY_CONFIRM="YES-I-UNDERSTAND" (exactly) to proceed. ' +
        "This sends a real transaction with real funds.",
    );
  }

  const poolAddress = process.env.MAINNET_DRYRUN_POOL_ADDRESS;
  const mint = process.env.MAINNET_DRYRUN_MINT;
  const dex = process.env.MAINNET_DRYRUN_DEX ?? "raydium-cpmm";
  const amountSol = Number(process.env.FIRST_REAL_BUY_AMOUNT_SOL ?? "0.01");

  if (!poolAddress || !mint) {
    throw new Error("Set MAINNET_DRYRUN_POOL_ADDRESS and MAINNET_DRYRUN_MINT.");
  }
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error(`Invalid FIRST_REAL_BUY_AMOUNT_SOL: ${amountSol}`);
  }
  if (
    amountSol > HARD_CEILING_SOL &&
    process.env.FIRST_REAL_BUY_OVERRIDE_CEILING !== "true"
  ) {
    throw new Error(
      `${amountSol} SOL exceeds the ${HARD_CEILING_SOL} SOL safety ceiling for a FIRST trade. ` +
        `If this is genuinely intentional, set FIRST_REAL_BUY_OVERRIDE_CEILING=true. ` +
        `If it's a typo (0.5 vs 0.05), this is exactly what caught it.`,
    );
  }

  const keypair = loadKeypair();
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  const mintPubkey = new PublicKey(mint);

  console.log("=".repeat(60));
  console.log("FIRST REAL TRADE — LIVE FUNDS");
  console.log("=".repeat(60));
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Pool:   ${poolAddress}`);
  console.log(`Mint:   ${mint}`);
  console.log(`Dex:    ${dex}`);
  console.log(`Amount: ${amountSol} SOL\n`);

  await printBalances(connection, keypair.publicKey, mintPubkey, "BEFORE");

  const candidate: CandidateMint = {
    mint,
    poolAddress,
    dex,
    poolCreatedAt: new Date(),
  };

  console.log("\nSending...\n");
  const result = await cpmmExecutor.buy(candidate, amountSol, {
    ownerWallet: keypair.publicKey.toBase58(),
    keypair,
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));

  await printBalances(connection, keypair.publicKey, mintPubkey, "AFTER");

  if (result.signature && !result.signature.startsWith("sim-")) {
    console.log(`\nSolscan: https://solscan.io/tx/${result.signature}`);
  }

  if (!result.success) {
    console.error(
      "\n❌ Trade failed or outcome unknown — read the `reason` field above carefully.",
    );
    console.error(
      "If the result is `outcome: unknown` territory (check logs above for that phrase), the balances printed above are the source of truth on whether funds moved — not this script's own success flag.",
    );
    process.exit(1);
  }
  console.log(
    "\n✅ First real buy confirmed. Save this pool address and mint — you'll need them for scripts/first-real-sell.ts.",
  );
}

main().catch((err) => {
  console.error("\n💥 Crashed:", err);
  process.exit(1);
});
