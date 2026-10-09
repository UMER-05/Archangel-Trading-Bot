import axios from "axios";
import { getLogger } from "../utils/logger.js";

const log = getLogger("swap.service");

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Minimal token universe until Birdeye/Jupiter discovery is added
 */
const TRACKED_TOKENS = [
  { mint: SOL_MINT, symbol: "SOL", name: "Solana" },
  { mint: USDC_MINT, symbol: "USDC", name: "USD Coin" },
];

/**
 * Get up-to-date price for SOL & USDC using Helius Token API
 */
export async function fetchHeliusPrices() {
  try {
    const mints = TRACKED_TOKENS.map((t) => t.mint).join(",");
    const heliusApiKey = process.env.HELIUS_API_KEY || "";
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const url = `${heliusUrl}/v0/token-price?ids=${mints}`;

    const { data } = await axios.get(url, { timeout: 8_000 });
    const priceData = data;

    return TRACKED_TOKENS.map((t) => ({
      ...t,
      price: priceData[t.mint]?.price ?? null,
    }));
  } catch (err: any) {
    log.error({ err: err.message }, "Helius price fetch failed");
    return TRACKED_TOKENS;
  }
}
