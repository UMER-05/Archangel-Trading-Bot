import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

const BREAKOUT_WINDOW = 10;
const BREAKOUT_THRESHOLD = 0.05; // 5% above previous high

export const breakoutStrategy: TradingStrategy = {
  name: "breakout",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const { priceHistory, currentPrice } = context;
    if (!priceHistory || priceHistory.length < BREAKOUT_WINDOW) {
      return {
        shouldBuy: false,
        shouldSell: false,
        reason: "Not enough price history",
      };
    }
    const window = priceHistory.slice(-BREAKOUT_WINDOW);
    const prevHigh = Math.max(...window.slice(0, -1));
    if (currentPrice > prevHigh * (1 + BREAKOUT_THRESHOLD)) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Breakout above ${Math.round(BREAKOUT_THRESHOLD * 100)}%`,
        score: currentPrice - prevHigh,
      };
    }
    return { shouldBuy: false, shouldSell: false, reason: "No breakout" };
  },
};
