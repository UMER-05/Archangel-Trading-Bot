import {
  TradingStrategy,
  StrategyContext,
  StrategyResult,
} from "./strategyEngine.js";

// Copy-trading: Buys if a smart money wallet or whitelisted address buys
export const copyTradingStrategy: TradingStrategy = {
  name: "copyTrading",
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    // Example: Check if a smart money wallet bought recently
    const { tokenMeta } = context;
    if (tokenMeta?.recentSmartBuy) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Copy-trading: Smart wallet bought`,
      };
    }
    return {
      shouldBuy: false,
      shouldSell: false,
      reason: "No smart money signal",
    };
  },
};
