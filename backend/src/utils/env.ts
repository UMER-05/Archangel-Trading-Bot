import dotenv from "dotenv";
dotenv.config();

const requireEnv = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};

export const ENV = {
  PORT: process.env.PORT ?? process.env.WEBSITES_PORT ?? "4000",
  FRONTEND_URL:
    process.env.FRONTEND_URL ??
    process.env.AZURE_FRONTEND_URL ??
    "http://163.245.201.188",

  // DB
  MONGO_URI: process.env.MONGO_URI ?? "",
  MONGO_DB_NAME: process.env.MONGO_DB_NAME ?? "archangel",

  // Helius + RPC
  HELIUS_RPC_URL: process.env.HELIUS_RPC_URL ?? "",
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? "",

  // Solami Blur realtime stream (services/blurStream.service.ts). The stream
  // only starts when SOLAMI_BLUR_API_KEY is set; the key needs the DataApi
  // permission. SOLAMI_BLUR_WS_URL may point at a regional endpoint (e.g.
  // wss://fra.ws.solami.dev/data/subscribe). SOLAMI_BLUR_DEXES is an optional
  // comma-separated ALLOW-list of DEX names — Blur's dex filter can only
  // include, not exclude. Empty = every DEX.
  SOLAMI_BLUR_API_KEY: process.env.SOLAMI_BLUR_API_KEY ?? "",
  SOLAMI_BLUR_WS_URL:
    process.env.SOLAMI_BLUR_WS_URL ?? "wss://ws.solami.dev/data/subscribe",
  SOLAMI_BLUR_DEXES: (process.env.SOLAMI_BLUR_DEXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Jupiter aggregator API
  JUPITER_API_URL: process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag",
  JUPITER_API_KEY: process.env.JUPITER_API_KEY ?? "",

  // Feature flags
  USE_REAL_SWAP: process.env.USE_REAL_SWAP === "true",
  // Execution router — see services/execution/executionRouter.service.ts.
  // Off by default; no native executors exist yet, so enabling this today
  // has no behavioral effect beyond an extra (currently-empty) lookup.
  RAYDIUM_NATIVE_EXECUTION_ENABLED:
    process.env.RAYDIUM_NATIVE_EXECUTION_ENABLED === "true",

  // Alerts
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
  ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM ?? "",
  ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO ?? "",

  // ADMIN wallet (server-side for signing auto-sell)
  ADMIN_WALLET_SECRET: process.env.ADMIN_WALLET_SECRET ?? "",

  // Quick tuning
  TOKEN_MIN_MARKETCAP_SOL: Number(process.env.TOKEN_MIN_MARKETCAP_SOL ?? "2"), // 2 SOL default

  // Advanced execution tuning
  JUPITER_PRIORITY_FEE: Number(process.env.JUPITER_PRIORITY_FEE ?? "0.00003"), // in SOL

  // Custom RPC and bundle/pre-sign options
  CUSTOM_RPC_URL: process.env.CUSTOM_RPC_URL ?? "",
  ENABLE_BUNDLE_PRESIGN: process.env.ENABLE_BUNDLE_PRESIGN === "true",

  // Jito/MEV relay support
  JITO_MEV_RELAY_ENABLED: process.env.JITO_MEV_RELAY_ENABLED === "true",
  JITO_MEV_RELAY_URL: process.env.JITO_MEV_RELAY_URL ?? "",

  // Blacklist/Whitelist (comma-separated lists)
  TOKEN_BLACKLIST: (process.env.TOKEN_BLACKLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  TOKEN_WHITELIST: (process.env.TOKEN_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Time-based entry filter (seconds)
  MIN_SECONDS_SINCE_LAUNCH: Number(
    process.env.MIN_SECONDS_SINCE_LAUNCH ?? "10",
  ),
  MAX_SECONDS_SINCE_LAUNCH: Number(
    process.env.MAX_SECONDS_SINCE_LAUNCH ?? "60",
  ),
};
