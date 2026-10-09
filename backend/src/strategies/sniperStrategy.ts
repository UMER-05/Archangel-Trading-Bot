import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

// Sniper: Buys immediately on pool creation or first liquidity, with optional filters
export const sniperStrategy: TradingStrategy = {
  name: "sniper",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    // Example: Only buy if pool just created and liquidity > threshold
    const { currentLiquidity, tokenMeta } = context;
    // Matches MIN_JUPITER_LIQUIDITY_SOL (the equivalent threshold used by the
    // other auto-buy path, validationPipeline.service.ts) by default, so both
    // paths agree on what counts as a real pool rather than one requiring 20x
    // more liquidity than the other for the same kind of check.
    const minLiquidity = Number(
      process.env.SNIPER_MIN_LIQUIDITY_SOL ??
        process.env.MIN_JUPITER_LIQUIDITY_SOL ??
        0.05
    );
    if (tokenMeta?.justLaunched && currentLiquidity >= minLiquidity) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Sniper: Pool just launched with ${currentLiquidity} SOL`,
      };
    }
    return {
      shouldBuy: false,
      shouldSell: false,
      reason: "Not a sniper opportunity",
    };
  },
};
