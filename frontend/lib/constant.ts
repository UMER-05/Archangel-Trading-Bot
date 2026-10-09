// frontend/lib/constant.ts

/**
 * ✅ Global constants for ArchAngel Trading Bot UI
 * Centralized config for environment keys and defaults
 */

// 🔹 Environment-based settings
//
// ONE backend origin drives everything: NEXT_PUBLIC_BACKEND_URL, which the
// rest of the app (lib/utils.ts's fetcher, lib/socket.ts) already reads.
// API_BASE_URL and SOCKET_URL used to have their own variables with
// localhost fallbacks, so a production build that set only
// NEXT_PUBLIC_BACKEND_URL sent every settings request to the visitor's own
// localhost:4000 and none of them worked. Both are now derived from it;
// NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_SOCKET_URL still override if set.
// (NEXT_PUBLIC_* values are inlined at BUILD time — rebuild after changing.)
const stripTrailingSlashes = (url: string) => url.replace(/\/+$/, "");
const BACKEND_URL = stripTrailingSlashes(
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000"
);

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || "development",
  BACKEND_URL,
  API_BASE_URL: stripTrailingSlashes(
    process.env.NEXT_PUBLIC_API_BASE_URL || `${BACKEND_URL}/api`
  ),
  SOCKET_URL: stripTrailingSlashes(
    process.env.NEXT_PUBLIC_SOCKET_URL || BACKEND_URL
  ), // backend socket server
  // Must match the env var names WalletProvider.tsx/useWallet.ts actually
  // read (NEXT_PUBLIC_SOLANA_ENDPOINT, with _RPC_URL as a legacy alias) —
  // this used to check NEXT_PUBLIC_SOLANA_RPC (no _URL), which nothing sets,
  // so it always silently fell through to the public rate-limited endpoint.
  SOLANA_RPC_URL:
    process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
};

// External links shown in the navbar and footer — ONE definition each. Docs
// used to be written two different ways (the navbar pointed at the GitBook
// site, the footer at docs.archangelbot.io), so which one a visitor got
// depended on where they clicked. Override any of them at build time with
// NEXT_PUBLIC_DOCS_URL / NEXT_PUBLIC_TWITTER_URL / NEXT_PUBLIC_GITHUB_URL.
export const SITE_LINKS = {
  docs: process.env.NEXT_PUBLIC_DOCS_URL || "https://archangel.gitbook.io/docs",
  twitter:
    process.env.NEXT_PUBLIC_TWITTER_URL || "https://twitter.com/archangelbot",
  github:
    process.env.NEXT_PUBLIC_GITHUB_URL ||
    "https://github.com/onuhvictor/archangel-bot",
};

// DEFAULT_CONFIG and API_ROUTES used to live here — removed. Neither was
// imported anywhere (useConfig.ts's useTradingConfigStore is the real
// source of trading defaults, and every API call goes through fetcher()/
// ENV.API_BASE_URL directly), and both had drifted from reality: DEFAULT_CONFIG's
// values (slippage 1.5%, stop-loss 5%) disagreed with the store's real
// defaults (1%, 2%), and API_ROUTES only listed 4 of the many endpoints
// that exist now. Dead constants that also happen to be wrong are worse
// than no constants — remove rather than leave as a landmine for whoever
// finds them next and assumes they're current.

// 🔹 App metadata
export const APP_INFO = {
  NAME: "ArchAngel Bot",
  VERSION: "1.0.0",
  AUTHOR: "ArchAngel Labs",
  DESCRIPTION:
    "AI-powered Solana trading bot for automating meme coin strategies.",
};

// 🔹 UI constants
export const UI = {
  REFRESH_INTERVAL: 10000, // ms
  SOCKET_RETRY_DELAY: 3000,
  MAX_TRADE_LOGS: 50,
};
