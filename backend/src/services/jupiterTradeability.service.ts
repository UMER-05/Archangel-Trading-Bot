// backend/src/services/jupiterTradeability.service.ts
//
// Phase 3 of the linear discovery→validate→buy pipeline (see
// candidatePipeline.service.ts for the full sequence): given a mint address,
// answer ONE question — is this token actually supported/tradeable on
// Jupiter right now? Nothing else.
//
// This is deliberately narrow, and deliberately quote-only: Jupiter's role
// in this pipeline is strictly trading (can it route a trade, and later,
// executing one) — never fetching token metadata/catalog data. That used to
// be blended together with Phase 4's ArchAngel filters (tax, mint/freeze
// authority, LP lock, holder concentration — see tokenFiltering.service.ts,
// which now sources authority data on-chain instead), which made "not
// tradeable" and "tradeable but fails our filters" the same code path and
// the same DB state, AND pulled in a Jupiter catalog lookup
// (/tokens/v2/search) that has nothing to do with trading. Jupiter doesn't
// know or care about tax rates or authority flags; it only knows whether it
// can route a trade. That separation is the point of this file.
import { getLogger } from "../utils/logger.js";
import jupiterService, {
  getSolPriceUsd,
  resolveLiquidityUsd,
  type JupiterQuote,
} from "./jupiter.service.js";
import { getOnChainMintSupply } from "./tokenSafetyChecks.service.js";

const LOG = getLogger("jupiter-tradeability");
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Small reference amount used purely to prove a route exists in both
// directions — not the real buy size (that's sized per-wallet later, in
// Phase 6). 0.01 SOL is enough to get a meaningful quote without being large
// enough to itself distort the price-impact reading on a brand-new pool.
const ROUTING_PROBE_LAMPORTS = 10_000_000;
const ROUTING_PROBE_SLIPPAGE_BPS = 1000;

// This pipeline queries Jupiter within milliseconds of a pool-creation
// transaction landing on-chain (see routes/quicknode.route.ts) — faster than
// Jupiter's own routing engine reliably indexes a brand-new pool. A quote
// that 400s immediately after launch is very often "not routable yet," not
// "never routable" — retry a few times, a beat apart, before concluding
// there's genuinely no route. This is specifically about Jupiter's indexing
// lag, not a timezone/clock issue — the quote endpoint has no time-based
// validation at all.
const BUY_QUOTE_RETRY_ATTEMPTS = 3;
const BUY_QUOTE_RETRY_DELAY_MS = 1000;

async function getBuyQuoteWithRetry(
  tokenMint: string,
): Promise<JupiterQuote | null> {
  for (let attempt = 1; attempt <= BUY_QUOTE_RETRY_ATTEMPTS; attempt++) {
    const quote = await jupiterService.getQuote(
      SOL_MINT,
      tokenMint,
      ROUTING_PROBE_LAMPORTS,
      ROUTING_PROBE_SLIPPAGE_BPS,
    );
    if (quote?.outAmount) return quote;

    if (attempt < BUY_QUOTE_RETRY_ATTEMPTS) {
      LOG.debug(
        `No Jupiter route yet for ${tokenMint.slice(0, 8)} (attempt ${attempt}/${BUY_QUOTE_RETRY_ATTEMPTS}) — retrying in ${BUY_QUOTE_RETRY_DELAY_MS}ms`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, BUY_QUOTE_RETRY_DELAY_MS),
      );
    }
  }
  return null;
}

export interface TradeabilityResult {
  tradeable: boolean;
  reason?: string;
  liquiditySol: number;
  liquidityUsd: number;
  buyQuote: JupiterQuote | null;
  sellQuote: JupiterQuote | null;
  // On-chain-derived market cap in SOL — supply straight from the mint
  // account, price implied by the buy quote above. Deliberately independent
  // of Birdeye: its FDV reads $0 for a token this fresh just as often as its
  // volume does, and market cap is the one filter the client specifically
  // wants enforced, not softened — it needs a source that doesn't share
  // Birdeye's indexing-lag failure mode. Undefined (not 0) when supply
  // wasn't available — the per-wallet mcap gate must keep treating "unknown"
  // and "genuinely below the minimum" as different things.
  launchMarketCapSol?: number;
}

/**
 * Phase 3 — Jupiter validation.
 *
 * `liquidityHintUsd` lets a caller that already has a fresh liquidity
 * reading (e.g. straight from the webhook's pool-creation payload) skip the
 * price-impact estimate below — that hint is expected to come from
 * QuickNode/on-chain data, not from Jupiter.
 */
export async function checkJupiterTradeability(
  tokenMint: string,
  opts: { liquidityHintUsd?: number } = {},
): Promise<TradeabilityResult> {
  const empty = {
    liquiditySol: 0,
    liquidityUsd: 0,
    buyQuote: null,
    sellQuote: null,
  };

  try {
    LOG.info(
      `🔍 [Phase 3] Checking Jupiter tradeability for ${tokenMint.slice(0, 8)}...`,
    );

    const solPriceUsd = await getSolPriceUsd();

    // Step 1: does Jupiter's aggregator actually route a buy? Retried — see
    // getBuyQuoteWithRetry's own comment for why a single immediate attempt
    // isn't reliable here.
    const buyQuote = await getBuyQuoteWithRetry(tokenMint);
    if (!buyQuote || !buyQuote.outAmount) {
      return {
        tradeable: false,
        reason: "No Jupiter buy route available",
        ...empty,
      };
    }

    // Step 1b: market cap, computed on-chain — supply from the mint account,
    // price implied by the buy quote just above. Independent of Birdeye on
    // purpose (see TradeabilityResult's doc comment). A missing/failed
    // supply lookup leaves this undefined rather than 0 — candidatePipeline
    // only records a launch mcap when this succeeds, and the per-wallet gate
    // (multiUserExecution.service.ts) already treats an unset value as
    // failing closed, not as "$0 market cap."
    let launchMarketCapSol: number | undefined;
    const supplyInfo = await getOnChainMintSupply(tokenMint);
    if (supplyInfo.available && solPriceUsd > 0) {
      const tokensReceived =
        Number(buyQuote.outAmount) / 10 ** supplyInfo.decimals;
      if (tokensReceived > 0) {
        const priceInSol = ROUTING_PROBE_LAMPORTS / 1e9 / tokensReceived;
        launchMarketCapSol = priceInSol * supplyInfo.supply;
      }
    }

    // Step 2: does it route back? A route that only works one way is either
    // a dead end or a honeypot — either way, not tradeable.
    const sellQuote = await jupiterService.getQuote(
      tokenMint,
      SOL_MINT,
      Number(buyQuote.outAmount),
      ROUTING_PROBE_SLIPPAGE_BPS,
    );
    if (!sellQuote || !sellQuote.outAmount) {
      return {
        tradeable: false,
        reason: "No Jupiter sell route available (potential honeypot)",
        liquiditySol: 0,
        liquidityUsd: 0,
        buyQuote,
        sellQuote: null,
        ...(launchMarketCapSol != null ? { launchMarketCapSol } : {}),
      };
    }

    // Step 3: is there real liquidity behind that route, or did it just
    // barely quote on a near-empty pool? Prefer a fresh hint from the caller
    // (e.g. the webhook/pool-creation event itself); otherwise fall back to
    // a price-impact-implied estimate from a reference quote (still a
    // trading function, not a catalog lookup) — see resolveLiquidityUsd's
    // own reasoning. Passed `null` for tokenInfo here on purpose: this
    // pipeline never fetches Jupiter's token catalog data, so that shortcut
    // path inside resolveLiquidityUsd is always skipped.
    let liquidityUsd: number;
    if (opts.liquidityHintUsd != null) {
      liquidityUsd = opts.liquidityHintUsd;
    } else {
      const resolved = await resolveLiquidityUsd(tokenMint, 0, solPriceUsd);
      liquidityUsd = resolved.liquidityUSD;
    }
    const liquiditySol = solPriceUsd > 0 ? liquidityUsd / solPriceUsd : 0;

    if (!(liquiditySol > 0)) {
      return {
        tradeable: false,
        reason: "No usable liquidity behind the Jupiter route",
        liquiditySol: 0,
        liquidityUsd: 0,
        buyQuote,
        sellQuote,
        ...(launchMarketCapSol != null ? { launchMarketCapSol } : {}),
      };
    }

    LOG.info(
      `✅ [Phase 3] ${tokenMint.slice(0, 8)} is tradeable on Jupiter (${liquiditySol.toFixed(2)} SOL liquidity)`,
    );
    return {
      tradeable: true,
      liquiditySol,
      liquidityUsd,
      buyQuote,
      sellQuote,
      ...(launchMarketCapSol != null ? { launchMarketCapSol } : {}),
    };
  } catch (err: any) {
    LOG.error(
      { tokenMint, err: err?.message },
      "Jupiter tradeability check failed",
    );
    return {
      tradeable: false,
      reason: `Tradeability check error: ${err?.message}`,
      ...empty,
    };
  }
}
