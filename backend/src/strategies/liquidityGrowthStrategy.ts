import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

const LIQ_GROWTH_WINDOW = 5;
const LIQ_GROWTH_THRESHOLD = 0.1; // 10% liquidity growth

export const liquidityGrowthStrategy: TradingStrategy = {
  name: "liquidityGrowth",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const { liquidityHistory, currentLiquidity } = context;
    if (!liquidityHistory || liquidityHistory.length < LIQ_GROWTH_WINDOW) {
      return {
        shouldBuy: false,
        shouldSell: false,
        reason: "Not enough liquidity history",
      };
    }
    const prevLiquidity =
      liquidityHistory[liquidityHistory.length - LIQ_GROWTH_WINDOW];
    if (prevLiquidity === undefined || prevLiquidity === 0) {
      return {
        shouldBuy: false,
        shouldSell: false,
        reason: "Previous liquidity undefined or zero",
      };
    }
    const change = (currentLiquidity - prevLiquidity) / prevLiquidity;
    if (change > LIQ_GROWTH_THRESHOLD) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Liquidity up ${Math.round(change * 100)}%`,
        score: change,
      };
    }
    if (change < -LIQ_GROWTH_THRESHOLD) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `Liquidity down ${Math.round(change * 100)}%`,
        score: change,
      };
    }
    return {
      shouldBuy: false,
      shouldSell: false,
      reason: "No strong liquidity growth",
    };
  },
};
