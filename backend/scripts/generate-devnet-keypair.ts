#!/usr/bin/env -S npx tsx
// backend/scripts/generate-devnet-keypair.ts
//
// Fallback for anyone without the Solana CLI (`solana-keygen`) installed.
// Generates a fresh keypair and prints both its address (to fund via a
// web faucet) and its secret key (to feed into DEVNET_SMOKE_TEST_SECRET_KEY).
//
// Usage: npx tsx scripts/generate-devnet-keypair.ts

import { Keypair } from "@solana/web3.js";

const kp = Keypair.generate();
const fs = await import("fs");

fs.writeFileSync(
  "devnet-smoke-test-key.json",
  JSON.stringify(Array.from(kp.secretKey)),
);

console.log("Address (fund this via a devnet faucet):");
console.log(kp.publicKey.toBase58());
console.log("\nFaucet: https://faucet.solana.com (select Devnet)\n");
console.log("Secret key written to devnet-smoke-test-key.json");
console.log("\nRun the smoke test with:");
console.log(
  "  $env:DEVNET_SMOKE_TEST_SECRET_KEY = Get-Content -Raw devnet-smoke-test-key.json",
);
console.log("  npx tsx scripts/devnet-smoke-test.ts");
