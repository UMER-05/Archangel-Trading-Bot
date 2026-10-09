/**
 * ==========================================================
 *  🧠 Unified Fetcher Utility
 * ==========================================================
 */
// A read (settings, balances, position lists) is either fast or genuinely
// broken; 30s is plenty and failing fast is the right default. An endpoint
// that submits or confirms an on-chain transaction is a different animal —
// Solana confirmation alone can take well past 30s under congestion, before
// the backend has even started building the transaction — so those callers
// pass a longer `timeoutMs` explicitly (see useSellBotPosition.ts,
// actions-bar.tsx, useTrade.ts). Aborting here only stops the BROWSER from
// waiting; the backend keeps working and the trade can still complete or
// fail on its own — a timeout is not a cancellation.
const DEFAULT_TIMEOUT_MS = 30_000;

export const fetcher = async <T = any>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> => {
  const BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

  const finalUrl = url.startsWith("http") ? url : `${BASE}${url}`;
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;

  try {
    res = await fetch(finalUrl, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(fetchOptions.headers || {}),
      },
    });
  } catch (err: any) {
    clearTimeout(timeout);

    if (err?.name === "AbortError") {
      // The browser gave up waiting — the backend may well still finish (or
      // already have). Made explicit here so callers that hit this on a
      // trade-execution endpoint know not to assume it failed outright.
      throw new Error(
        `⏳ Request timed out after ${Math.round(timeoutMs / 1000)}s: ${finalUrl} — the backend may still be processing this; check before retrying.`
      );
    }

    throw new Error(`🌐 Network error: ${err?.message || "Unknown error"}`);
  }

  clearTimeout(timeout);

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`❌ Invalid JSON response from ${finalUrl}`);
  }

  if (!res.ok || json?.success === false) {
    // Backend routes aren't consistent about the error key (some use
    // `message`, others `error`) — check both before falling back.
    throw new Error(
      json?.message ||
        json?.error ||
        `❌ Request failure: HTTP ${res.status} — ${res.statusText}`
    );
  }

  return json as T;
};

/**
 * 📌 POST helper
 */
export const post = async <T = any>(
  url: string,
  body: any,
  opts: { timeoutMs?: number } = {}
): Promise<T> =>
  fetcher<T>(url, {
    method: "POST",
    body: JSON.stringify(body),
    ...opts,
  });

/**
 * 🧩 Tailwind class combiner
 */
export function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ");
}

/**
 * 💰 Format numbers nicely
 */
export const formatNumber = (num: number, decimals = 2) =>
  Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
  }).format(num);

/**
 * 💵 Format a token price specifically — freshly-launched tokens routinely
 * price at a small fraction of a cent (e.g. $0.0000144), and formatNumber's
 * normal 2-decimal default rounds that straight to "0", which reads as "no
 * price data" even though a real price exists. Uses significant digits
 * instead of a fixed decimal count for anything under $1, so a genuinely
 * tiny price still shows real digits.
 */
export const formatPrice = (num: number): string => {
  if (!Number.isFinite(num)) return "—";
  if (num === 0) return "0";
  if (Math.abs(num) >= 1) return formatNumber(num, 2);
  return Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 4,
    minimumSignificantDigits: 2,
  }).format(num);
};

/**
 * 🔗 Shorten Solana addresses — matches the 8+4 convention used everywhere
 * else in the app truncates a mint/address inline (LiveTrades.tsx,
 * PipelineStatus.tsx, TokenDiscovery.tsx, etc.)
 */
export const truncateAddress = (address: string) =>
  address ? `${address.slice(0, 8)}...${address.slice(-4)}` : "";

/**
 * ⏰ Format timestamps
 */
export const formatTime = (date: Date | string) => {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", { hour12: false });
};
