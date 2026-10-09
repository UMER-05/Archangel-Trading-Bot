import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

const MOMENTUM_WINDOW = 5; // Number of price points to look back
const MOMENTUM_THRESHOLD = 0.03; // 3% upward move

export const momentumStrategy: TradingStrategy = {
  name: "momentum",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const { priceHistory, currentPrice } = context;
    if (!priceHistory || priceHistory.length < MOMENTUM_WINDOW) {
      return {
        shouldBuy: false,
        shouldSell: false,
        reason: "Not enough price history",
      };
    }
    const prevPrice = priceHistory[priceHistory.length - MOMENTUM_WINDOW];
    if (prevPrice === undefined || prevPrice === 0) {
      return {
        shouldBuy: false,
        shouldSell: false,
        reason: "Previous price undefined or zero",
      };
    }
    const change = (currentPrice - prevPrice) / prevPrice;
    if (change > MOMENTUM_THRESHOLD) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Momentum up ${Math.round(change * 100)}%`,
        score: change,
      };
    }
    if (change < -MOMENTUM_THRESHOLD) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `Momentum down ${Math.round(change * 100)}%`,
        score: change,
      };
    }
    return {
      shouldBuy: false,
      shouldSell: false,
      reason: "No strong momentum",
    };
  },
};
