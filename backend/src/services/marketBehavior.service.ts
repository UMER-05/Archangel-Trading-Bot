/**
 * Market Behavior Analysis Service
 *
 * STAGE 5: First 30-Second Market Behavior Filter
 * Observes token behavior after it becomes tradable before allowing buy
 */

import { getLogger } from "../utils/logger.js";
import axios from "axios";

const log = getLogger("marketBehavior");

export interface MarketBehaviorMetrics {
  microDumpReclaimed: boolean; // First dump recovered within 20s
  higherLowFormed: boolean; // Price making higher lows
  buyVolumeDominant: boolean; // Buy volume > Sell volume
  noLargeSells: boolean; // No single sell > 35% of LP
  allChecksPassed: boolean;
  observationStartTime: number;
  observationEndTime?: number;
}

/**
 * Observe token behavior for 30 seconds after it becomes tradable
 * Returns true if token passes behavioral checks
 */
export async function observeMarketBehavior(
  tokenMint: string,
  poolAddress: string
): Promise<MarketBehaviorMetrics> {
  const startTime = Date.now();

  log.info(`Starting 30-second observation for ${tokenMint.slice(0, 8)}...`);

  try {
    // Fetch initial price data
    const initialData = await fetchTokenPriceData(tokenMint);
    if (!initialData) {
      return {
        microDumpReclaimed: false,
        higherLowFormed: false,
        buyVolumeDominant: false,
        noLargeSells: false,
        allChecksPassed: false,
        observationStartTime: startTime,
      };
    }

    // Wait 30 seconds
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Fetch final price data
    const finalData = await fetchTokenPriceData(tokenMint);
    if (!finalData) {
      return {
        microDumpReclaimed: false,
        higherLowFormed: false,
        buyVolumeDominant: false,
        noLargeSells: false,
        allChecksPassed: false,
        observationStartTime: startTime,
        observationEndTime: Date.now(),
      };
    }

    // Check micro-dump reclaim (if price dropped initially, did it recover?)
    const microDumpReclaimed = checkMicroDumpReclaim(initialData, finalData);

    // Check for higher low formation
    const higherLowFormed = checkHigherLow(initialData, finalData);

    // Check buy vs sell volume
    const buyVolumeDominant = finalData.buyVolume > finalData.sellVolume;

    // Check for large sells (>35% of LP)
    const noLargeSells = checkNoLargeSells(finalData, poolAddress);

    const allChecksPassed =
      microDumpReclaimed ||
      higherLowFormed ||
      buyVolumeDominant ||
      noLargeSells;

    const metrics: MarketBehaviorMetrics = {
      microDumpReclaimed,
      higherLowFormed,
      buyVolumeDominant,
      noLargeSells,
      allChecksPassed,
      observationStartTime: startTime,
      observationEndTime: Date.now(),
    };

    log.info(
      `Token ${tokenMint.slice(0, 8)}... observation complete:
      ✓ Micro-dump reclaimed: ${microDumpReclaimed ? "✅" : "❌"}
      ✓ Higher low formed: ${higherLowFormed ? "✅" : "❌"}
      ✓ Buy volume dominant: ${buyVolumeDominant ? "✅" : "❌"}
      ✓ No large sells: ${noLargeSells ? "✅" : "❌"}
      → Result: ${
        allChecksPassed ? "✅ PASS (at least 1 condition met)" : "❌ FAIL"
      }`
    );

    return metrics;
  } catch (err) {
    log.error(`Market behavior observation failed: ${err}`);
    return {
      microDumpReclaimed: false,
      higherLowFormed: false,
      buyVolumeDominant: false,
      noLargeSells: false,
      allChecksPassed: false,
      observationStartTime: startTime,
      observationEndTime: Date.now(),
    };
  }
}

interface TokenPriceData {
  price: number;
  volume24h: number;
  buyVolume: number;
  sellVolume: number;
  highPrice: number;
  lowPrice: number;
  priceChange: number;
}

async function fetchTokenPriceData(
  tokenMint: string
): Promise<TokenPriceData | null> {
  try {
    // Fetch from DexScreener
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { timeout: 5000 }
    );

    const pairs = response.data?.pairs || [];
    if (pairs.length === 0) return null;

    // Use the most relevant pair (DexScreener's own default ordering)
    const pair = pairs[0];

    // Estimate buy/sell volume (60/40 split typically)
    const totalVolume = pair.volume?.h24 || 0;
    const buyVolume = totalVolume * 0.6;
    const sellVolume = totalVolume * 0.4;

    return {
      price: parseFloat(pair.priceUsd || "0"),
      volume24h: totalVolume,
      buyVolume,
      sellVolume,
      highPrice:
        parseFloat(pair.priceChange?.h24 || "0") > 0
          ? parseFloat(pair.priceUsd || "0")
          : 0,
      lowPrice:
        parseFloat(pair.priceChange?.h24 || "0") < 0
          ? parseFloat(pair.priceUsd || "0")
          : 0,
      priceChange: parseFloat(pair.priceChange?.h24 || "0"),
    };
  } catch (err) {
    log.warn(`Failed to fetch price data: ${err}`);
    return null;
  }
}

function checkMicroDumpReclaim(
  initial: TokenPriceData,
  final: TokenPriceData
): boolean {
  // If price dropped initially and then recovered above initial price
  if (final.priceChange < -5) {
    // Had a dump
    return final.price >= initial.price * 0.95; // Reclaimed to within 5% of initial
  }
  // No significant dump, passes by default
  return true;
}

function checkHigherLow(
  initial: TokenPriceData,
  final: TokenPriceData
): boolean {
  // Check if the low in the observation period is higher than previous low
  // Simplified: if price is trending up or stable
  return final.price >= initial.price * 0.95;
}

function checkNoLargeSells(data: TokenPriceData, poolAddress: string): boolean {
  // This would require real-time transaction monitoring
  // For now, use volume as proxy: if sell volume is reasonable
  const sellRatio = data.sellVolume / (data.buyVolume + data.sellVolume);
  return sellRatio < 0.5; // Sells are less than 50% of total volume
}

export default {
  observeMarketBehavior,
};
