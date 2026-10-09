import jupiterService, {
  SOL_MINT,
  getSolPriceUsd,
  resolveLiquidityUsd,
} from "./jupiter.service.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("tokenLifecycle");

/**
 * Token lifecycle stages, Jupiter-only.
 *
 * Previously modeled Pump.fun's bonding-curve → graduation → Raydium-pool journey
 * (PUMP_FUN_BONDING, GRADUATED_NO_POOL, GRADUATED_ZERO_LIQUIDITY, FULLY_TRADABLE).
 * With Jupiter as the sole execution venue, there's no separate pre-pool bonding
 * stage to track — a token is either tradable through the aggregator right now
 * (with real liquidity) or it isn't.
 */
export enum TokenLifecycleStage {
  TRADABLE = "tradable",
  ZERO_LIQUIDITY = "zero_liquidity", // has a route but liquidity is effectively zero
  NOT_TRADABLE = "not_tradable", // no Jupiter route at all
  UNKNOWN = "unknown",
}

export interface TokenLifecycleResult {
  mint: string;
  stage: TokenLifecycleStage;
  hasLiquidity: boolean;
  liquiditySOL?: number;
  isTradable: boolean;
  errorMessage?: string;
  timestamp: number;
}

/**
 * Validate a token's tradability via Jupiter: a real quote + real liquidity.
 * Deliberately quote-only — Jupiter's role here is strictly trading (does a
 * route exist, and how deep is the liquidity behind it, both derived from
 * actual quotes), never a token metadata/catalog fetch. That means no pool
 * address is available here (that used to come from Jupiter's catalog data,
 * which isn't fetched anywhere in this pipeline anymore); callers that need
 * a pool address have it from elsewhere (the QuickNode webhook event that
 * found the token in the first place — see candidatePipeline.service.ts).
 */
export async function validateTokenLifecycle(
  tokenMint: string,
): Promise<TokenLifecycleResult> {
  const result: TokenLifecycleResult = {
    mint: tokenMint,
    stage: TokenLifecycleStage.UNKNOWN,
    hasLiquidity: false,
    isTradable: false,
    timestamp: Date.now(),
  };

  try {
    log.info(`Validating lifecycle for token ${tokenMint.slice(0, 8)}...`);

    const smallAmountLamports = 1_000_000; // 0.001 SOL
    const [quote, solPriceUsd] = await Promise.all([
      jupiterService.getQuote(SOL_MINT, tokenMint, smallAmountLamports, 500),
      getSolPriceUsd(),
    ]);

    if (!quote) {
      result.stage = TokenLifecycleStage.NOT_TRADABLE;
      result.isTradable = false;
      result.errorMessage = "No Jupiter route found";
      log.info(`Token ${tokenMint.slice(0, 8)}... has no Jupiter route`);
      return result;
    }

    // Liquidity derived purely from a price-impact estimate off the quote
    // above — no separate Jupiter catalog lookup involved, so a token that
    // just got a route can never read as "$0 liquidity" from a stale/missing
    // catalog entry. (The liquidity figure is USD and must be divided by the
    // SOL price to become "SOL".)
    const minLiquidityUsdHint = 0.05 * solPriceUsd; // rough USD equivalent of the downstream 0.05 SOL floor
    const { liquidityUSD } = await resolveLiquidityUsd(
      tokenMint,
      minLiquidityUsdHint,
      solPriceUsd,
    );
    const liquiditySOL = solPriceUsd > 0 ? liquidityUSD / solPriceUsd : 0;
    result.liquiditySOL = liquiditySOL;
    result.hasLiquidity = liquiditySOL > 0;

    if (result.hasLiquidity) {
      result.stage = TokenLifecycleStage.TRADABLE;
      result.isTradable = true;
      log.info(
        `Token ${tokenMint.slice(0, 8)}... is tradable via Jupiter with ${liquiditySOL.toFixed(
          4,
        )} SOL liquidity`,
      );
    } else {
      result.stage = TokenLifecycleStage.ZERO_LIQUIDITY;
      result.isTradable = false;
      result.errorMessage = "Jupiter route exists but liquidity is zero";
      log.warn(
        `Token ${tokenMint.slice(0, 8)}... has a route but zero liquidity`,
      );
    }

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(
      `Lifecycle validation failed for ${tokenMint.slice(0, 8)}...: ${errorMsg}`,
    );

    result.stage = TokenLifecycleStage.UNKNOWN;
    result.isTradable = false;
    result.errorMessage = `Validation error: ${errorMsg}`;
    return result;
  }
}

/**
 * Batch validate multiple tokens and classify them. No longer prefetches a
 * batch catalog lookup (there's nothing to prefetch — each validation below
 * is just a quote + a price-impact estimate, both per-mint trading calls
 * that don't benefit from batching the way a catalog search did).
 */
export async function validateTokenBatch(tokenMints: string[]): Promise<{
  tradable: TokenLifecycleResult[];
  notTradable: TokenLifecycleResult[];
  summary: {
    total: number;
    tradableCount: number;
    zeroLiquidity: number;
    unknown: number;
  };
}> {
  log.info(`Batch validating ${tokenMints.length} tokens...`);

  const results = await Promise.all(
    tokenMints.map((mint) => validateTokenLifecycle(mint)),
  );

  const tradable = results.filter((r) => r.isTradable);
  const notTradable = results.filter((r) => !r.isTradable);

  const summary = {
    total: results.length,
    tradableCount: tradable.length,
    zeroLiquidity: results.filter(
      (r) => r.stage === TokenLifecycleStage.ZERO_LIQUIDITY,
    ).length,
    unknown: results.filter((r) => r.stage === TokenLifecycleStage.UNKNOWN)
      .length,
  };

  log.info(
    `Batch validation complete: ${summary.tradableCount}/${summary.total} tradable ` +
      `(${summary.zeroLiquidity} zero liquidity, ${summary.unknown} unknown)`,
  );

  return { tradable, notTradable, summary };
}

/**
 * Get human-readable status message for lifecycle result
 */
export function getLifecycleStatusMessage(
  result: TokenLifecycleResult,
): string {
  switch (result.stage) {
    case TokenLifecycleStage.TRADABLE:
      return `✅ Tradable via Jupiter with ${
        result.liquiditySOL?.toFixed(2) || "active"
      } liquidity`;
    case TokenLifecycleStage.ZERO_LIQUIDITY:
      return "⚠️ Jupiter route exists but liquidity is zero - Not Tradable";
    case TokenLifecycleStage.NOT_TRADABLE:
      return "⏳ No Jupiter route available yet - Not Tradable";
    case TokenLifecycleStage.UNKNOWN:
      return `❓ ${result.errorMessage || "Unable to determine token status"} - Not Tradable`;
    default:
      return "❓ Unknown status";
  }
}

export default {
  validateTokenLifecycle,
  validateTokenBatch,
  getLifecycleStatusMessage,
  TokenLifecycleStage,
};
