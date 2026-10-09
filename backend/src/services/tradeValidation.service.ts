/**
 * ArchAngel Trade Validation Service
 *
 * Implements the CRITICAL CONDITIONS for safe trading, Jupiter-only:
 * 1. "Jupiter Tradable" Filter (real route + liquidity via Jupiter aggregator)
 * 2. "No Instant Dump" Anti-Manipulation Filter (safety checks)
 *
 * (Previously had a 3rd, separate "About to Graduate" bonding-curve condition and a
 * "Raydium Migration Confirmed" condition — those only made sense for Pump.fun's
 * bonding-curve-then-pool lifecycle. With Jupiter, a token either has a real
 * executable route right now or it doesn't; there's no separate pre-pool stage.)
 */

import jupiterService, {
  SOL_MINT,
  getSolPriceUsd,
  resolveLiquidityUsd,
} from "./jupiter.service.js";
import {
  getHolderDistribution,
  checkPoolStillLive,
  fetchRugCheckReport,
  getOnChainMintAuthorityStatus,
} from "./tokenSafetyChecks.service.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("tradeValidation");

/**
 * Jupiter tradability + liquidity metrics
 */
export interface JupiterLiquidityMetrics {
  exists: boolean;
  liquiditySOL: number;
  liquidityUSD: number;
  mcapUSD: number;
  mcapSOL?: number;
  holderCount: number;
  poolAddress?: string;
  meetsMinimumLiquidity: boolean;
  buyRouteAvailable?: boolean;
  sellRouteAvailable?: boolean;
  buyPriceImpactPct?: number;
}

/**
 * Anti-manipulation safety checks
 */
export interface SafetyChecks {
  canSell: boolean; // Test sell successful
  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpRemovable: boolean;
  buyTax: number;
  sellTax: number;
  isHoneypot: boolean;
  allChecksPassed: boolean;
}

/**
 * Complete trade validation result
 */
export interface TradeValidationResult {
  mint: string;
  approved: boolean;

  // Condition 1: Jupiter Tradable
  jupiterMetrics: JupiterLiquidityMetrics;
  condition1Passed: boolean;

  // Condition 2: No Instant Dump
  safetyChecks: SafetyChecks;
  condition2Passed: boolean;

  recommendation: "BUY" | "IGNORE";
  reason: string;
  timestamp: number;
}

/**
 * CONDITION 1: Confirm the token has a real, sufficiently-liquid Jupiter route
 */
async function checkJupiterTradable(
  tokenMint: string,
): Promise<{ metrics: JupiterLiquidityMetrics; passed: boolean }> {
  try {
    const smallAmountLamports = 1_000_000; // 0.001 SOL test
    const [quote, solPriceUsd] = await Promise.all([
      jupiterService.getQuote(SOL_MINT, tokenMint, smallAmountLamports, 100),
      getSolPriceUsd(),
    ]);

    if (!quote) {
      return {
        metrics: {
          exists: false,
          liquiditySOL: 0,
          liquidityUSD: 0,
          mcapUSD: 0,
          holderCount: 0,
          meetsMinimumLiquidity: false,
        },
        passed: false,
      };
    }

    // Aggressive mode: $1,500 minimum. Safe mode: $5,000 minimum.
    const tradingMode = process.env.TRADING_MODE || "aggressive";
    const minLiquidityUSD = tradingMode === "safe" ? 5000 : 1500;

    // Liquidity derived purely from a price-impact estimate off the quote
    // above — a trading function, not a Jupiter catalog/metadata fetch. See
    // resolveLiquidityUsd's own doc comment.
    const { liquidityUSD, source: liquiditySource } = await resolveLiquidityUsd(
      tokenMint,
      minLiquidityUSD,
      solPriceUsd,
    );
    const liquiditySOL = solPriceUsd > 0 ? liquidityUSD / solPriceUsd : 0;
    const meetsMinimum = liquidityUSD >= minLiquidityUSD;

    // mcapUSD/holderCount used to come from Jupiter's catalog data — that's
    // no longer fetched anywhere in this pipeline, so these are informational
    // zeros rather than real figures. Neither field gates the trade decision
    // (only `exists`/`meetsMinimumLiquidity` do); poolAddress is similarly
    // unavailable without a catalog lookup, so performSafetyChecks below
    // falls back to its own "largest non-pool holder" heuristic.
    const metrics: JupiterLiquidityMetrics = {
      exists: true,
      liquiditySOL,
      liquidityUSD,
      mcapUSD: 0,
      holderCount: 0,
      meetsMinimumLiquidity: meetsMinimum,
    };

    const passed = metrics.exists && metrics.meetsMinimumLiquidity;

    log.info(
      `Token ${tokenMint.slice(0, 8)}... Jupiter liquidity: ${liquiditySOL.toFixed(
        2,
      )} SOL ($${liquidityUSD.toFixed(0)}, source: ${liquiditySource}) | Min: $${minLiquidityUSD} (${tradingMode} mode) | Condition 1: ${
        passed ? "✅ PASS" : "❌ FAIL"
      }`,
    );

    return { metrics, passed };
  } catch (err) {
    log.error(`Error checking Jupiter tradability: ${err}`);
    return {
      metrics: {
        exists: false,
        liquiditySOL: 0,
        liquidityUSD: 0,
        mcapUSD: 0,
        holderCount: 0,
        meetsMinimumLiquidity: false,
      },
      passed: false,
    };
  }
}

/**
 * CONDITION 2: Perform anti-manipulation safety checks
 */
async function performSafetyChecks(
  tokenMint: string,
  poolAddress?: string,
): Promise<{ checks: SafetyChecks; passed: boolean }> {
  try {
    // Mint/freeze authority — straight from the mint account on-chain, not
    // Jupiter's catalog. Jupiter's role in this pipeline is strictly trading
    // (the route/quote checks above and in checkJupiterTradable), never a
    // token metadata fetch.
    const authorityStatus = await getOnChainMintAuthorityStatus(tokenMint);
    const mintAuthorityNull =
      authorityStatus.available && authorityStatus.mintAuthorityDisabled;
    const freezeAuthorityNull =
      authorityStatus.available && authorityStatus.freezeAuthorityDisabled;

    const {
      creatorHoldings,
      top3Combined,
      available: holderDataAvailable,
    } = await getHolderDistribution(tokenMint, {
      excludeOwners: [poolAddress],
    });

    let canSell = false;
    try {
      // Test with a realistic amount, not a fixed raw-unit constant: 1000 base
      // units is dust for almost any token (Jupiter returns NO_ROUTES_FOUND for
      // amounts that small even on the deepest pools, e.g. BONK) and would make
      // this check fail universally regardless of whether the token is sellable.
      // Quote a small real buy first, then test selling that resulting amount back.
      const probeBuyQuote = await jupiterService.getQuote(
        SOL_MINT,
        tokenMint,
        1_000_000, // 0.001 SOL
        1000,
      );
      if (probeBuyQuote?.outAmount) {
        const testQuote = await jupiterService.getQuote(
          tokenMint,
          SOL_MINT,
          probeBuyQuote.outAmount,
          1000, // High slippage tolerance for test
        );
        if (testQuote && testQuote.outAmount > 0) {
          canSell = true;
          log.debug(
            `Test sell quote successful for ${tokenMint.slice(0, 8)}... - ${
              testQuote.outAmount
            } lamports expected`,
          );
        }
      }
    } catch (err) {
      log.warn(`Test sell failed for ${tokenMint.slice(0, 8)}...: ${err}`);
      canSell = false;
    }

    // Fail closed if the concentration data itself couldn't be fetched — see
    // getHolderDistribution's `available` flag.
    const creatorBelowLimit = holderDataAvailable && creatorHoldings <= 20;
    const top3BelowLimit = holderDataAvailable && top3Combined <= 60;

    const lpNotRemoved = await checkPoolStillLive(tokenMint, poolAddress);

    // Tax/honeypot via RugCheck — mirrors the same check the auto-buy
    // candidate pipeline runs in tokenFiltering.service.ts's Phase 4
    // filtering, so a manual buy through this validator gets the same
    // protection an auto-bought token does. Fails closed on an unavailable
    // report, same reasoning as tokenFiltering.service.ts.
    const rugCheck = await fetchRugCheckReport(tokenMint);
    const maxBuyTax = Number(process.env.MAX_BUY_TAX_PCT ?? 5);
    const maxSellTax = Number(process.env.MAX_SELL_TAX_PCT ?? 5);
    const taxAcceptable =
      rugCheck.available &&
      rugCheck.taxes.buyTax <= maxBuyTax &&
      rugCheck.taxes.sellTax <= maxSellTax;
    const notHoneypot = rugCheck.available && !rugCheck.isHoneypot;

    const checks: SafetyChecks = {
      canSell,
      mintAuthority: mintAuthorityNull ? null : "unknown",
      freezeAuthority: freezeAuthorityNull ? null : "unknown",
      lpRemovable: !lpNotRemoved,
      buyTax: rugCheck.taxes.buyTax,
      sellTax: rugCheck.taxes.sellTax,
      isHoneypot: !rugCheck.available || rugCheck.isHoneypot,
      allChecksPassed:
        canSell &&
        mintAuthorityNull &&
        freezeAuthorityNull &&
        creatorBelowLimit &&
        top3BelowLimit &&
        lpNotRemoved &&
        taxAcceptable &&
        notHoneypot,
    };

    const passed = checks.allChecksPassed;

    log.info(
      `Token ${tokenMint.slice(0, 8)}... Safety Checks:
      ✓ Sell Test: ${canSell ? "✅" : "❌"}
      ✓ Mint Authority: ${mintAuthorityNull ? "✅ DISABLED" : "❌ ENABLED"}
      ✓ Freeze Authority: ${freezeAuthorityNull ? "✅ DISABLED" : "❌ ENABLED"}
      ✓ Creator Holdings: ${creatorHoldings.toFixed(1)}% ${
        creatorBelowLimit ? "✅ ≤20%" : "❌ >20%"
      }
      ✓ Top 3 Wallets: ${top3Combined.toFixed(1)}% ${
        top3BelowLimit ? "✅ ≤60%" : "❌ >60%"
      }
      ✓ Tax: buy ${checks.buyTax}% / sell ${checks.sellTax}% ${
        taxAcceptable ? "✅" : "❌"
      }
      ✓ Honeypot: ${notHoneypot ? "✅ CLEAR" : "❌ FLAGGED/UNVERIFIED"}
      → Condition 2: ${passed ? "✅ PASS" : "❌ FAIL"}`,
    );

    return { checks, passed };
  } catch (err) {
    log.error(`Error performing safety checks: ${err}`);
    return {
      checks: {
        canSell: false,
        mintAuthority: "UNKNOWN",
        freezeAuthority: "UNKNOWN",
        lpRemovable: true,
        buyTax: 0,
        sellTax: 0,
        isHoneypot: true,
        allChecksPassed: false,
      },
      passed: false,
    };
  }
}

/**
 * MAIN VALIDATION: Check both conditions and approve/reject trade
 */
export async function validateTradeOpportunity(
  tokenMint: string,
): Promise<TradeValidationResult> {
  log.info(`🔍 Validating trade opportunity for ${tokenMint.slice(0, 8)}...`);

  const { metrics: jupiterMetrics, passed: condition1 } =
    await checkJupiterTradable(tokenMint);

  // Skip the (expensive) safety checks entirely if there's no route/liquidity at all
  const { checks: safetyChecks, passed: condition2 } = condition1
    ? await performSafetyChecks(tokenMint, jupiterMetrics.poolAddress)
    : {
        checks: {
          canSell: false,
          mintAuthority: "UNKNOWN",
          freezeAuthority: "UNKNOWN",
          lpRemovable: true,
          buyTax: 0,
          sellTax: 0,
          isHoneypot: true,
          allChecksPassed: false,
        } as SafetyChecks,
        passed: false,
      };

  const allConditionsPassed = condition1 && condition2;

  let recommendation: "BUY" | "IGNORE" = "IGNORE";
  let reason = "";

  if (allConditionsPassed) {
    recommendation = "BUY";
    reason = "✅ All conditions passed - SNIPE OPPORTUNITY!";
  } else if (!condition1) {
    reason = `❌ No Jupiter route or insufficient liquidity ($${jupiterMetrics.liquidityUSD.toFixed(
      0,
    )})`;
  } else {
    reason = "❌ Failed safety checks - SCAM RISK";
  }

  const result: TradeValidationResult = {
    mint: tokenMint,
    approved: allConditionsPassed,
    jupiterMetrics,
    condition1Passed: condition1,
    safetyChecks,
    condition2Passed: condition2,
    recommendation,
    reason,
    timestamp: Date.now(),
  };

  log.info(
    `🎯 Validation result: ${recommendation} - ${reason} | C1: ${
      condition1 ? "✅" : "❌"
    } C2: ${condition2 ? "✅" : "❌"}`,
  );

  return result;
}

/**
 * Batch validate multiple tokens
 */
export async function validateBatchTradeOpportunities(
  tokenMints: string[],
): Promise<TradeValidationResult[]> {
  log.info(`📊 Batch validating ${tokenMints.length} trade opportunities...`);

  const results = await Promise.all(
    tokenMints.map((mint) => validateTradeOpportunity(mint)),
  );

  const approved = results.filter((r) => r.approved);
  const ignored = results.filter((r) => !r.approved);

  log.info(
    `📊 Batch results: ${approved.length} APPROVED | ${ignored.length} IGNORED`,
  );

  return results;
}
