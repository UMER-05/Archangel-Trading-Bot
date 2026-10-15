// backend/src/utils/tradingReadiness.ts
//
// One startup report of every environment-level gate that decides whether
// the bot can auto-buy at all. Each of these used to fail silently or only at
// debug level, which production logging (info and up) never prints — so an
// installed copy with an incomplete .env just "didn't pick trades" with no
// trace of why. Pure function of an env object so it can be unit-tested;
// never includes a secret value, only whether it is set.
import fs from "fs";
import path from "path";

export type ReadinessLevel = "ok" | "warn" | "error";

export interface ReadinessItem {
  level: ReadinessLevel;
  check: string;
  detail: string;
}

export interface ReadinessOptions {
  /** Directory dotenv resolved `.env` against (dotenv uses process.cwd()). */
  cwd?: string;
  /** Result of trying to load the operator keypair (public key or error). */
  operatorWallet?: { publicKey: string } | { error: string };
}

export function checkTradingReadiness(
  env: NodeJS.ProcessEnv,
  opts: ReadinessOptions = {},
): ReadinessItem[] {
  const items: ReadinessItem[] = [];

  if (opts.cwd !== undefined) {
    const envPath = path.resolve(opts.cwd, ".env");
    items.push(
      fs.existsSync(envPath)
        ? { level: "ok", check: ".env file", detail: `loaded from ${envPath}` }
        : {
            level: "warn",
            check: ".env file",
            detail: `none at ${envPath} — only variables already in the process environment are used`,
          },
    );
  }

  items.push(
    env.SOLAMI_BLUR_API_KEY
      ? { level: "ok", check: "Discovery (Blur stream)", detail: "SOLAMI_BLUR_API_KEY is set" }
      : {
          level: "error",
          check: "Discovery (Blur stream)",
          detail: "SOLAMI_BLUR_API_KEY is not set — no new tokens will be discovered",
        },
  );

  items.push(
    env.JUPITER_AUTO_BUY === "true"
      ? { level: "ok", check: "Auto-buy", detail: "JUPITER_AUTO_BUY=true" }
      : {
          level: "error",
          check: "Auto-buy",
          detail: `JUPITER_AUTO_BUY is ${
            env.JUPITER_AUTO_BUY === undefined
              ? "not set"
              : `"${env.JUPITER_AUTO_BUY}"`
          } (must be exactly "true") — tokens are filtered but never bought`,
        },
  );

  items.push(
    env.USE_REAL_SWAP === "true"
      ? { level: "ok", check: "Swap mode", detail: "USE_REAL_SWAP=true (real on-chain buys)" }
      : {
          level: "warn",
          check: "Swap mode",
          detail: 'USE_REAL_SWAP is not "true" — buys are SIMULATED, nothing is sent on-chain',
        },
  );

  items.push(
    env.SOLANA_RPC_URL
      ? { level: "ok", check: "Solana RPC", detail: "SOLANA_RPC_URL is set" }
      : {
          level: "warn",
          check: "Solana RPC",
          detail:
            "SOLANA_RPC_URL is not set — using the public mainnet RPC, which commonly refuses the holder-distribution query, so the safety filter rejects every token",
        },
  );

  items.push(
    env.MONGO_URI
      ? { level: "ok", check: "Database", detail: "MONGO_URI is set" }
      : { level: "error", check: "Database", detail: "MONGO_URI is not set" },
  );

  if (opts.operatorWallet) {
    items.push(
      "publicKey" in opts.operatorWallet
        ? {
            level: "ok",
            check: "Operator wallet",
            detail: `loaded (${opts.operatorWallet.publicKey.slice(0, 8)}…)`,
          }
        : {
            level: "warn",
            check: "Operator wallet",
            detail: `not usable (${opts.operatorWallet.error}) — only user hot wallets can auto-buy`,
          },
    );
  }

  return items;
}
