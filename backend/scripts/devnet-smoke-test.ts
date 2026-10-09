#!/usr/bin/env -S npx tsx
// backend/scripts/devnet-smoke-test.ts
//
// Stage A of the devnet smoke test described in
// docs/devnet-smoke-test-guide.md. Read that doc first — it explains why
// this script deliberately does NOT exercise an actual Raydium swap: real
// Raydium CPMM pools with real liquidity don't reliably exist on devnet,
// so this validates everything that doesn't need one — real devnet
// transactions, real signing, real confirmation via sender.ts's own
// retry/guard logic — while Stage B (scripts/mainnet-dry-run.ts) covers
// the actual Raydium SDK integration via simulation against a real
// mainnet pool, with zero funds ever leaving the wallet.
//
// SAFETY: this script refuses to run unless the configured RPC URL looks
// like devnet, or DEVNET_SMOKE_TEST_I_KNOW_THIS_ISNT_DEVNET=true is set.
// It sends REAL transactions — on devnet, so the SOL involved is
// worthless, but the guard exists so a misconfigured RPC URL can't
// silently turn this into a mainnet money-mover.
//
// Usage:
//   DEVNET_SMOKE_TEST_SECRET_KEY='[12,34,...]' npx tsx scripts/devnet-smoke-test.ts
//
// Requires a devnet wallet funded with at least ~0.05 SOL (use
// `solana airdrop 1 <address> --url devnet` or a devnet faucet).

import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildWrapSolInstructions,
  buildUnwrapSolInstruction,
  NATIVE_MINT,
} from "../src/services/execution/transaction/wsol.js";
import { buildEnsureAtaInstruction } from "../src/services/execution/transaction/ata.js";
import { sendAndConfirmWithRetry } from "../src/services/execution/transaction/sender.js";
import { determineComputeUnitLimit } from "../src/services/execution/raydium/cpmm.js";

const RPC_URL =
  process.env.DEVNET_SMOKE_TEST_RPC_URL ?? "https://api.devnet.solana.com";

function loadKeypair(): Keypair {
  const raw = (process.env.DEVNET_SMOKE_TEST_SECRET_KEY ?? "").trim();
  if (!raw) {
    throw new Error(
      "DEVNET_SMOKE_TEST_SECRET_KEY is not set — use a DEDICATED devnet-only keypair, never a real trading wallet's key.",
    );
  }
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    /* fall through to base58 */
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

function assertLooksLikeDevnet() {
  const allowNonDevnet =
    process.env.DEVNET_SMOKE_TEST_I_KNOW_THIS_ISNT_DEVNET === "true";
  if (!RPC_URL.includes("devnet") && !allowNonDevnet) {
    throw new Error(
      `Refusing to run: RPC URL "${RPC_URL}" doesn't look like devnet. ` +
        `This script sends real transactions. If you're SURE this is safe ` +
        `(e.g. a local test validator), set DEVNET_SMOKE_TEST_I_KNOW_THIS_ISNT_DEVNET=true.`,
    );
  }
}

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    console.log(`  ✅ PASS`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ FAIL: ${err?.message ?? err}`);
    failed++;
  }
}

async function main() {
  assertLooksLikeDevnet();
  const connection = new Connection(RPC_URL, "confirmed");
  const keypair = loadKeypair();
  const owner = keypair.publicKey;

  console.log(`Devnet smoke test`);
  console.log(`RPC:    ${RPC_URL}`);
  console.log(`Wallet: ${owner.toBase58()}`);

  await step("RPC connectivity + balance check", async () => {
    const lamports = await connection.getBalance(owner, "confirmed");
    console.log(`  Balance: ${lamports / 1e9} SOL`);
    if (lamports < 0.05 * 1e9) {
      throw new Error(
        `Balance too low (${lamports / 1e9} SOL) — airdrop at least 0.05 devnet SOL first: ` +
          `solana airdrop 1 ${owner.toBase58()} --url devnet`,
      );
    }
  });

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);

  await step("WSOL wrap: build + send + confirm via sender.ts", async () => {
    const wrapLamports = 10_000_000; // 0.01 SOL
    const { instructions } = buildWrapSolInstructions(owner, wrapLamports);

    const result = await sendAndConfirmWithRetry(
      connection,
      async ({ blockhash }) => {
        const message = new TransactionMessage({
          payerKey: owner,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message([]);
        const tx = new VersionedTransaction(message);
        tx.sign([keypair]);
        return tx;
      },
      {
        initialComputeUnitPriceMicroLamports: 1,
        maxAttempts: 2,
        confirmTimeoutMs: 20_000,
      },
    );

    if (result.outcome !== "confirmed") {
      throw new Error(`WSOL wrap did not confirm: ${JSON.stringify(result)}`);
    }
    console.log(`  Signature: ${result.signature}`);

    const balance = await connection.getTokenAccountBalance(
      wsolAta,
      "confirmed",
    );
    console.log(`  WSOL ATA balance: ${balance.value.uiAmountString} SOL`);
    if (Number(balance.value.amount) !== wrapLamports) {
      throw new Error(
        `Expected WSOL balance ${wrapLamports}, got ${balance.value.amount} — syncNative may not have run correctly`,
      );
    }
  });

  await step("ATA idempotent re-creation is a safe no-op", async () => {
    const { instruction } = buildEnsureAtaInstruction(owner, NATIVE_MINT);
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [instruction],
    }).compileToV0Message([]);
    const tx = new VersionedTransaction(message);
    tx.sign([keypair]);
    // Simulate rather than send — the ATA already exists from the wrap
    // step above, so this only needs to confirm the idempotent
    // instruction doesn't error against an already-existing account.
    const { value } = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: false,
    });
    if (value.err) {
      throw new Error(
        `Idempotent re-create failed: ${JSON.stringify(value.err)}`,
      );
    }
  });

  await step(
    "Compute-unit probe returns a measured (non-fallback) limit",
    async () => {
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: owner,
            lamports: 1,
          }),
        ],
      }).compileToV0Message([]);
      const tx = new VersionedTransaction(message);

      const limit = await determineComputeUnitLimit(
        connection,
        tx,
        keypair,
        {},
        "smoke-test",
      );
      console.log(`  Measured limit: ${limit} CU`);
      // 300_000 is the fallback constant — landing exactly on it would mean
      // the probe silently failed and fell back rather than actually
      // measuring anything. A trivial transfer should measure far lower.
      if (limit === 300_000) {
        throw new Error(
          "Got exactly the fallback value (300000) — the probe likely failed silently; check logs above",
        );
      }
    },
  );

  await step(
    "WSOL unwrap: close account, reclaim rent, via sender.ts",
    async () => {
      const balanceBefore = await connection.getBalance(owner, "confirmed");
      const { instruction } = buildUnwrapSolInstruction(owner);

      const result = await sendAndConfirmWithRetry(
        connection,
        async ({ blockhash }) => {
          const message = new TransactionMessage({
            payerKey: owner,
            recentBlockhash: blockhash,
            instructions: [instruction],
          }).compileToV0Message([]);
          const tx = new VersionedTransaction(message);
          tx.sign([keypair]);
          return tx;
        },
        {
          initialComputeUnitPriceMicroLamports: 1,
          maxAttempts: 2,
          confirmTimeoutMs: 20_000,
        },
      );

      if (result.outcome !== "confirmed") {
        throw new Error(
          `WSOL unwrap did not confirm: ${JSON.stringify(result)}`,
        );
      }
      console.log(`  Signature: ${result.signature}`);

      const accountInfo = await connection.getAccountInfo(wsolAta, "confirmed");
      if (accountInfo !== null) {
        throw new Error(
          "WSOL ATA still exists after unwrap — close instruction may not have run",
        );
      }
      const balanceAfter = await connection.getBalance(owner, "confirmed");
      console.log(
        `  Balance change: ${(balanceAfter - balanceBefore) / 1e9} SOL (should be positive: unwrapped SOL + reclaimed rent, minus network fee)`,
      );
    },
  );

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 Smoke test crashed:", err);
  process.exit(1);
});
