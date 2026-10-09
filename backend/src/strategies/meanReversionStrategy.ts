import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

const MEAN_WINDOW = 10;
const DEVIATION_THRESHOLD = 0.07; // 7% deviation

export const meanReversionStrategy: TradingStrategy = {
  name: "meanReversion",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const { priceHistory, currentPrice } = context;
    if (!priceHistory || priceHistory.length < MEAN_WINDOW) {
      return {
        shouldBuy: false,
        shouldSell: false,
        reason: "Not enough price history",
      };
    }
    const window = priceHistory.slice(-MEAN_WINDOW);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const deviation = (currentPrice - mean) / mean;
    if (deviation < -DEVIATION_THRESHOLD) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Below mean by ${Math.round(deviation * 100)}%`,
        score: deviation,
      };
    }
    if (deviation > DEVIATION_THRESHOLD) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `Above mean by ${Math.round(deviation * 100)}%`,
        score: deviation,
      };
    }
    return { shouldBuy: false, shouldSell: false, reason: "Near mean" };
  },
};
