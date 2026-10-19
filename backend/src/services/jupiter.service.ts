// backend/src/services/jupiter.service.ts
// Single point of contact with Jupiter's aggregator API — quotes, swap execution,
// and the "recent tokens" feed used for discovery. Replaces the old Raydium-only
// execution layer and Pump.fun bonding-curve trading entirely.
import axios from "axios";
import crypto from "crypto";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getConnection, loadKeypairFromEnv } from "./solana.service.js";
import { ENV } from "../utils/env.js";
import { quoteCache } from "./cache.service.js";

const LOG = getLogger("jupiter.service");

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// The candidate pipeline can be processing several mints concurrently
// (concurrent webhook deliveries) and each stage — tradeability, filtering,
// per-wallet quoting — fires its own Jupiter calls, all funneling through
// this one file. A naive "has enough time passed since the last request"
// check isn't atomic across independent async call chains: several chains
// can all read the same stale `lastRequestAt`, each conclude they're clear
// to fire, and burst anyway. This queue instead gives every outgoing
// Jupiter request a single, real dispatch point: one FIFO queue, a hard
// concurrency cap, and a minimum spacing between dispatch times, enforced
// centrally rather than hoped for.
const MAX_CONCURRENT_REQUESTS = Number(
  process.env.JUPITER_MAX_CONCURRENT_REQUESTS ?? 4,
);
const MIN_REQUEST_SPACING_MS = Number(
  process.env.JUPITER_MIN_REQUEST_SPACING_MS ?? 150,
);

interface QueuedRequest {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const requestQueue: QueuedRequest[] = [];
let activeRequests = 0;
let lastDispatchAt = 0;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

function pumpQueue(): void {
  if (pumpTimer) return; // a pump is already scheduled; it will re-check on fire
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || requestQueue.length === 0) {
    return;
  }

  const wait = lastDispatchAt + MIN_REQUEST_SPACING_MS - Date.now();
  if (wait > 0) {
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpQueue();
    }, wait);
    return;
  }

  const item = requestQueue.shift()!;
  lastDispatchAt = Date.now();
  activeRequests++;
  item.run().then(
    (result) => {
      activeRequests--;
      item.resolve(result);
      pumpQueue();
    },
    (err) => {
      activeRequests--;
      item.reject(err);
      pumpQueue();
    },
  );

  // Concurrency slot may still be free (or spacing may already be clear for
  // the next one) — try to dispatch more right away instead of waiting for
  // this one to settle.
  pumpQueue();
}

function scheduleJupiterRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    requestQueue.push({
      run: fn,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pumpQueue();
  });
}

const DEFAULT_RETRIES = Number(process.env.JUPITER_MAX_RETRIES ?? 4);
const RETRY_BACKOFF_BASE_MS = Number(
  process.env.JUPITER_RETRY_BACKOFF_BASE_MS ?? 1000,
);

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  attempt = 0,
  retries = DEFAULT_RETRIES,
): Promise<T> {
  try {
    return await scheduleJupiterRequest(fn);
  } catch (err: any) {
    if (err?.response?.status === 429 && attempt < retries) {
      // Exponential backoff (1s, 2s, 4s, 8s, ...) plus a little jitter so a
      // batch of requests that all got 429'd together don't all retry in
      // lockstep and immediately collide again.
      const backoffMs =
        RETRY_BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      LOG.warn(
        `Jupiter ${label} 429 — retrying in ${backoffMs}ms (attempt ${
          attempt + 1
        }/${retries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return withRetry(fn, label, attempt + 1, retries);
    }
    throw err;
  }
}

let cachedSolPriceUsd: { price: number; fetchedAt: number } | null = null;

/**
 * Real-time SOL/USD price via a Jupiter quote (cached briefly so every caller
 * doesn't spam a fresh quote). Shared by anything that needs to convert Jupiter's
 * USD-denominated liquidity/mcap figures into SOL.
 */
export async function getSolPriceUsd(): Promise<number> {
  if (cachedSolPriceUsd && Date.now() - cachedSolPriceUsd.fetchedAt < 30000) {
    return cachedSolPriceUsd.price;
  }
  try {
    const { data } = await withRetry(
      () =>
        axios.get(
          `${process.env.JUPITER_API_URL || "https://lite-api.jup.ag"}/swap/v1/quote`,
          {
            params: {
              inputMint: SOL_MINT,
              outputMint: USDC_MINT,
              amount: 1e9,
              slippageBps: 100,
            },
            timeout: 8000,
          },
        ),
      "getSolPriceUsd",
    );
    if (data?.outAmount) {
      const price = Number(data.outAmount) / 1e6; // USDC has 6 decimals
      cachedSolPriceUsd = { price, fetchedAt: Date.now() };
      return price;
    }
  } catch (err: any) {
    LOG.warn(
      { err: err?.message ?? String(err) },
      "Failed to fetch live SOL price, using fallback",
    );
  }
  return cachedSolPriceUsd?.price ?? 150; // conservative fallback
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  otherAmountThreshold: number;
  priceImpactPct: number;
  slippageBps: number;
  raw: any; // full quote response, required verbatim as the `quoteResponse` body for /swap
}

export interface JupiterSwapResult {
  success: boolean;
  signature?: string;
  simulated?: boolean;
  error?: string;
}

class JupiterService {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = process.env.JUPITER_API_URL || "https://lite-api.jup.ag";
    this.apiKey = process.env.JUPITER_API_KEY || "";
  }

  private headers() {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  /**
   * GET /swap/v1/quote
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number | string | bigint,
    slippageBps = 500,
  ): Promise<JupiterQuote | null> {
    try {
      const amountStr = String(amountLamports);
      const cacheKey = `jupiter:quote:${inputMint}:${outputMint}:${amountStr}:${slippageBps}`;
      const cached = quoteCache.get<JupiterQuote>(cacheKey);
      if (cached) return cached;

      const { data } = await withRetry(
        () =>
          axios.get(`${this.baseUrl}/swap/v1/quote`, {
            params: {
              inputMint,
              outputMint,
              amount: amountStr,
              slippageBps,
              restrictIntermediateTokens: true,
            },
            headers: this.headers(),
            timeout: 8000,
          }),
        "getQuote",
      );

      if (!data || !data.outAmount) {
        LOG.warn(
          { inputMint, outputMint },
          "Jupiter quote returned no route/outAmount",
        );
        return null;
      }

      const quote: JupiterQuote = {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inAmount: Number(data.inAmount),
        outAmount: Number(data.outAmount),
        otherAmountThreshold: Number(
          data.otherAmountThreshold ?? data.outAmount,
        ),
        priceImpactPct: Number(data.priceImpactPct ?? 0),
        slippageBps: Number(data.slippageBps ?? slippageBps),
        raw: data,
      };

      quoteCache.set(cacheKey, quote);
      return quote;
    } catch (err: any) {
      LOG.warn(
        { inputMint, outputMint, err: err?.message ?? String(err) },
        "Jupiter quote request failed",
      );
      return null;
    }
  }

  /**
   * POST /swap/v1/swap — builds the unsigned swap transaction for a given quote.
   * Public: also used to prepare a transaction for client-side (frontend wallet) signing.
   */
  async buildSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    priorityFeeSol?: number,
  ): Promise<{ swapTransaction: string; lastValidBlockHeight: number } | null> {
    try {
      const priorityFeeLamports = Math.max(
        Math.round((priorityFeeSol ?? ENV.JUPITER_PRIORITY_FEE) * 1e9),
        0,
      );

      const { data } = await withRetry(
        () =>
          axios.post(
            `${this.baseUrl}/swap/v1/swap`,
            {
              quoteResponse: quote.raw,
              userPublicKey,
              wrapAndUnwrapSol: true,
              dynamicComputeUnitLimit: true,
              ...(priorityFeeLamports > 0
                ? { prioritizationFeeLamports: priorityFeeLamports }
                : {}),
            },
            { headers: this.headers(), timeout: 15000 },
          ),
        "buildSwapTransaction",
      );

      if (!data?.swapTransaction) {
        LOG.warn("Jupiter /swap returned no swapTransaction");
        return null;
      }

      return {
        swapTransaction: data.swapTransaction,
        lastValidBlockHeight: data.lastValidBlockHeight,
      };
    } catch (err: any) {
      LOG.error(
        { err: err?.response?.data ?? err?.message ?? String(err) },
        "Failed to build Jupiter swap transaction",
      );
      return null;
    }
  }

  private async sendRaw(
    connection: Connection,
    tx: VersionedTransaction,
  ): Promise<string> {
    const raw = tx.serialize();

    if (ENV.JITO_MEV_RELAY_ENABLED && ENV.JITO_MEV_RELAY_URL) {
      try {
        const base64Tx = Buffer.from(raw).toString("base64");
        const response = await axios.post(
          ENV.JITO_MEV_RELAY_URL,
          { transaction: base64Tx },
          { headers: { "Content-Type": "application/json" }, timeout: 10000 },
        );
        const signature = response.data?.result || response.data?.signature;
        if (signature) {
          LOG.info({ signature }, "Sent via Jito relay");
          return signature;
        }
        LOG.warn("Jito relay returned no signature, falling back to RPC");
      } catch (err: any) {
        LOG.warn(
          { err: err?.message ?? String(err) },
          "Jito relay send failed, falling back to RPC",
        );
      }
    }

    return connection.sendRawTransaction(raw, {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });
  }

  /**
   * Get a quote, build the swap transaction, sign, and send (or simulate).
   * Mirrors the old executeRaydiumSwap interface for drop-in compatibility with callers.
   */
  async executeSwap({
    inputMint,
    outputMint,
    amount,
    userPublicKey,
    slippageBps = 500,
    signer,
    priorityFeeSol,
  }: {
    inputMint: string;
    outputMint: string;
    amount: number | string;
    userPublicKey: string;
    slippageBps?: number;
    priorityFeeSol?: number;
    // Per-user custodial trading: the wallet that actually signs must match
    // userPublicKey (Jupiter builds the transaction's token accounts/fee
    // payer around userPublicKey, so a mismatched signer would fail on-chain
    // or worse, sign a transaction moving a DIFFERENT wallet's funds).
    // Defaults to the single admin/operator keypair for every existing
    // caller that doesn't pass one — unchanged behavior for them.
    signer?: Keypair;
  }): Promise<JupiterSwapResult> {
    try {
      const quote = await this.getQuote(
        inputMint,
        outputMint,
        amount,
        slippageBps,
      );
      if (!quote) {
        return { success: false, error: "No Jupiter route/quote available" };
      }

      const built = await this.buildSwapTransaction(
        quote,
        userPublicKey,
        priorityFeeSol,
      );
      if (!built) {
        return {
          success: false,
          error: "Failed to build Jupiter swap transaction",
        };
      }

      const tx = VersionedTransaction.deserialize(
        Buffer.from(built.swapTransaction, "base64"),
      );

      const useReal = process.env.USE_REAL_SWAP === "true";
      const connection = getConnection();
      const actualSigner = signer ?? loadKeypairFromEnv();
      // The transaction was built around userPublicKey (token accounts, fee
      // payer). Signing it with any other keypair would either fail on-chain
      // or, worse, succeed while moving funds/paying fees from the wrong
      // wallet — so this must never be silently mismatched.
      if (actualSigner.publicKey.toBase58() !== userPublicKey) {
        return {
          success: false,
          error: "Signer does not match userPublicKey — refusing to sign",
        };
      }
      tx.sign([actualSigner]);

      if (!useReal) {
        const { value } = await connection.simulateTransaction(tx, {
          commitment: "confirmed",
          sigVerify: false,
        });
        if (value.err) {
          return {
            success: false,
            error: `Simulation failed: ${JSON.stringify(value.err)}`,
          };
        }
        return {
          success: true,
          signature: `sim-${crypto.randomUUID()}`,
          simulated: true,
        };
      }

      const signature = await this.sendRaw(connection, tx);
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: tx.message.recentBlockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        "confirmed",
      );

      // "Confirmed" only means the transaction LANDED in a block. A swap that
      // reverted on-chain (slippage exceeded, pool state changed, account
      // missing) still confirms — with `err` set — and the wallet keeps its
      // tokens, minus the fee. This used to be ignored, so every reverted
      // auto-sell was recorded as a real sale with the quoted proceeds and the
      // position was marked closed while the tokens stayed in the hot wallet.
      // The on-chain scan of one wallet showed 20+ such "sold" positions.
      const onChainErr = confirmation?.value?.err;
      if (onChainErr) {
        const error = `Transaction ${signature} landed but failed on-chain: ${JSON.stringify(onChainErr)}`;
        LOG.error({ signature, err: onChainErr }, "Jupiter swap reverted on-chain");
        return { success: false, error };
      }

      LOG.info({ signature }, "Jupiter swap confirmed");
      return { success: true, signature, simulated: false };
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      LOG.error({ err: errorMsg }, "Jupiter swap execution failed");
      return { success: false, error: errorMsg };
    }
  }
}

const jupiterService = new JupiterService();
export default jupiterService;

// Minimum size for the reference-liquidity probe below — small enough not
// to matter for a real buy, large enough that price-impact stops rounding
// to zero in Jupiter's response even on a fairly thin pool.
const MIN_REFERENCE_PROBE_USD = 25;

/**
 * Liquidity for a token, resolved purely from a real quote — never from
 * Jupiter's /tokens/v2/search catalog. Jupiter's role in this codebase is
 * strictly trading (routing checks, quotes, execution), so this derives
 * liquidity the same way an actual trade would "feel" it: a price-impact
 * estimate from one real reference-sized quote, using the same routing
 * engine the real trade will use. If that reference-sized quote can't
 * route, that IS genuine evidence of thin liquidity, so it's reported as $0
 * rather than "unavailable".
 */
export async function resolveLiquidityUsd(
  tokenMint: string,
  minLiquidityUsdHint: number,
  solPriceUsd: number,
): Promise<{
  liquidityUSD: number;
  source: "impact-estimate" | "unavailable";
}> {
  if (solPriceUsd <= 0) {
    return { liquidityUSD: 0, source: "unavailable" };
  }

  const referenceAmountUsd = Math.max(
    minLiquidityUsdHint * 0.05,
    MIN_REFERENCE_PROBE_USD,
  );
  const referenceLamports = Math.round(
    (referenceAmountUsd / solPriceUsd) * 1e9,
  );
  const referenceQuote = await jupiterService.getQuote(
    SOL_MINT,
    tokenMint,
    referenceLamports,
    500,
  );

  if (!referenceQuote) {
    return { liquidityUSD: 0, source: "impact-estimate" };
  }

  const impact = referenceQuote.priceImpactPct;
  if (!Number.isFinite(impact) || impact < 0) {
    return { liquidityUSD: 0, source: "unavailable" };
  }
  if (impact === 0) {
    // Immeasurably small impact from moving referenceAmountUsd — the pool is
    // at least comfortably deeper than that reference size.
    return { liquidityUSD: referenceAmountUsd * 20, source: "impact-estimate" };
  }

  // Constant-product approximation: for a small trade relative to pool
  // depth, price impact ≈ amountIn / reserveIn. Jupiter's own "liquidity"
  // figure is the combined USD value of both sides of the pool, so double
  // the implied one-sided reserve to match that convention.
  const estimated = (2 * referenceAmountUsd) / impact;
  return { liquidityUSD: estimated, source: "impact-estimate" };
}

// Small reference amount for quote-implied pricing/liquidity estimates —
// large enough to get a meaningful quote, small enough to minimize the
// estimate's own price-impact distortion on a thin pool.
const PRICE_PROBE_LAMPORTS = 10_000_000; // 0.01 SOL

/**
 * Fair-value price for a token, in SOL per whole token — derived from a
 * small reference buy quote, not fetched from any price feed. This is the
 * only price source left anywhere in this codebase that isn't Jupiter
 * execution itself: no token-metadata catalog, no third-party price API.
 *
 * Understand the tradeoff before using this for anything besides a rough
 * estimate: a quote — even a small one — always bakes in that trade's own
 * price impact on top of the pool's real bid-ask spread, so it's a biased
 * (usually slightly high, for a buy-side quote) read of "true" spot price,
 * not an aggregated fair-value feed. It's precise enough for "is this
 * candidate's implied market cap roughly in range" or "how has this
 * position's value moved," and it deliberately CANNOT be used to justify a
 * PnL calculation that looks better/worse than reality by more than a
 * couple of the pool's own percentage points of slippage.
 *
 * Returns null if no route exists or a decimals lookup elsewhere failed —
 * callers must treat that as "unknown," not "zero."
 */
export async function getQuoteImpliedPriceSol(
  tokenMint: string,
  tokenDecimals: number,
): Promise<number | null> {
  if (!(tokenDecimals >= 0)) return null;

  const now = Date.now();
  const entry = priceProbeCache.get(tokenMint);

  // Fresh enough — every caller (positions route, stats route, position
  // monitor, pnl tracker) shares this one answer instead of each firing its
  // own Jupiter quote for the same mint within the same few seconds.
  if (entry && now - entry.attemptedAt < PRICE_PROBE_TTL_MS) {
    return staleOrNull(entry, now);
  }

  // Coalesce: one in-flight Jupiter fetch per mint, no matter how many
  // concurrent callers ask. The fetch keeps running after any caller gives
  // up waiting below, so the cache still gets refreshed for the next one.
  let inflight = priceProbeInflight.get(tokenMint);
  if (!inflight) {
    inflight = fetchQuoteImpliedPriceSol(tokenMint, tokenDecimals)
      .then((price) => {
        const prev = priceProbeCache.get(tokenMint);
        priceProbeCache.set(tokenMint, {
          attemptedAt: Date.now(),
          price: price ?? prev?.price ?? null,
          priceAt: price != null ? Date.now() : prev?.priceAt ?? 0,
        });
        return price;
      })
      .finally(() => {
        priceProbeInflight.delete(tokenMint);
      });
    priceProbeInflight.set(tokenMint, inflight);
  }

  // Hard deadline: under a Jupiter 429 storm a single quote can spend
  // tens of seconds in retry backoff. A dashboard request (or a monitor
  // tick) must not hang on that — after the deadline, fall back to the last
  // known price if it's recent enough, otherwise report "unknown".
  const result = await Promise.race([
    inflight.then((price) => ({ settled: true as const, price })),
    new Promise<{ settled: false }>((resolve) =>
      setTimeout(() => resolve({ settled: false }), PRICE_PROBE_MAX_WAIT_MS),
    ),
  ]);

  if (result.settled) {
    if (result.price != null) return result.price;
    return staleOrNull(priceProbeCache.get(tokenMint), Date.now());
  }
  LOG.warn(
    { tokenMint: tokenMint.slice(0, 8), waitedMs: PRICE_PROBE_MAX_WAIT_MS },
    "Price probe still pending past deadline — using last known price",
  );
  return staleOrNull(entry, Date.now());
}

/**
 * Cache-only price for DASHBOARD reads (positions route, stats/valuation).
 * Never waits on Jupiter: returns the last known price if it is recent enough
 * (see PRICE_PROBE_STALE_MAX_MS), else null. If the cache has nothing fresh and
 * nothing in flight, one background refresh is started so the NEXT request can
 * be answered — the caller still gets an immediate answer this time.
 *
 * The position monitor refreshes the cache for every bot-managed position
 * on its own 5-second tick via getQuoteImpliedPriceSol, so in practice the
 * dashboard reads prices the bot already paid for. This is what stops ten
 * dashboard polls a minute from competing with the buy pipeline for the
 * Jupiter rate limit (which is what was delaying buys).
 */
export function getCachedQuoteImpliedPriceSol(
  tokenMint: string,
  tokenDecimals: number,
): number | null {
  if (!(tokenDecimals >= 0)) return null;
  const now = Date.now();
  const entry = priceProbeCache.get(tokenMint);
  const fresh = entry && now - entry.attemptedAt < PRICE_PROBE_TTL_MS;
  if (!fresh && !priceProbeInflight.has(tokenMint)) {
    // Fire-and-forget; getQuoteImpliedPriceSol owns the inflight map and the
    // cache write, so this shares one fetch with any concurrent caller.
    void getQuoteImpliedPriceSol(tokenMint, tokenDecimals).catch(() => null);
  }
  return staleOrNull(entry, now);
}

/** The uncached, uncoalesced single Jupiter quote behind getQuoteImpliedPriceSol. */
async function fetchQuoteImpliedPriceSol(
  tokenMint: string,
  tokenDecimals: number,
): Promise<number | null> {
  const quote = await jupiterService.getQuote(
    SOL_MINT,
    tokenMint,
    PRICE_PROBE_LAMPORTS,
    500,
  );
  if (!quote?.outAmount) return null;
  const outTokens = Number(quote.outAmount) / 10 ** tokenDecimals;
  if (!(outTokens > 0)) return null;
  return PRICE_PROBE_LAMPORTS / 1e9 / outTokens;
}

interface PriceProbeEntry {
  attemptedAt: number; // last time a fetch finished (success or not)
  price: number | null; // last successfully fetched price
  priceAt: number; // when that price was fetched
}

// How long one fetched price is reused by every caller before refetching.
const PRICE_PROBE_TTL_MS = Number(process.env.PRICE_PROBE_CACHE_MS ?? 15_000);
// How long a caller waits on an in-flight fetch before settling for the
// last known price. Comfortably under the frontend's 30s request timeout
// even with the RPC decimals lookup in front of it.
const PRICE_PROBE_MAX_WAIT_MS = Number(
  process.env.PRICE_PROBE_MAX_WAIT_MS ?? 8_000,
);
// Oldest last-known price still worth showing instead of "unknown".
const PRICE_PROBE_STALE_MAX_MS = Number(
  process.env.PRICE_PROBE_STALE_MAX_MS ?? 5 * 60_000,
);

const priceProbeCache = new Map<string, PriceProbeEntry>();
const priceProbeInflight = new Map<string, Promise<number | null>>();

function staleOrNull(
  entry: PriceProbeEntry | undefined,
  now: number,
): number | null {
  if (!entry || entry.price == null) return null;
  return now - entry.priceAt <= PRICE_PROBE_STALE_MAX_MS ? entry.price : null;
}

// Named convenience exports matching the old raydium.service.ts call-site shape,
// so downstream files can migrate with a mostly mechanical import swap.
export const getJupiterQuote = (
  inputMint: string,
  outputMint: string,
  amountLamports: number | string | bigint,
  slippageBps?: number,
) =>
  jupiterService.getQuote(inputMint, outputMint, amountLamports, slippageBps);

export const executeJupiterSwap = (params: {
  inputMint: string;
  outputMint: string;
  amount: number | string;
  userPublicKey: string;
  slippageBps?: number;
  priorityFeeSol?: number;
  signer?: Keypair;
}) => jupiterService.executeSwap(params);

/**
 * Build an unsigned swap transaction for client-side (frontend wallet) signing.
 * Mirrors the old raydium.service.ts buildRaydiumSwapPayload interface.
 */
export const buildJupiterSwapPayload = async (
  quote: JupiterQuote,
  userPublicKey: string,
  priorityFeeSol?: number,
) => {
  const built = await jupiterService.buildSwapTransaction(
    quote,
    userPublicKey,
    priorityFeeSol,
  );
  if (!built) throw new Error("Failed to build Jupiter swap transaction");
  return { swapTransaction: built.swapTransaction };
};
