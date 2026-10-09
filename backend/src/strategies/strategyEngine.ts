// Modular Strategy Engine for Trading Bot
// Supports plug-and-play strategies: momentum, breakout, liquidity/volume growth, sniper, copy-trading, mean reversion, etc.

export interface StrategyContext {
  mint: string;
  priceHistory: number[];
  liquidityHistory: number[];
  volumeHistory: number[];
  currentPrice: number;
  currentLiquidity: number;
  currentVolume: number;
  tokenMeta?: any;
  [key: string]: any;
}

export interface StrategyResult {
  shouldBuy: boolean;
  shouldSell: boolean;
  reason: string;
  score?: number;
  extra?: any;
}

export interface TradingStrategy {
  name: string;
  evaluate(context: StrategyContext): Promise<StrategyResult>;
}

export class StrategyEngine {
  private strategies: TradingStrategy[] = [];

  register(strategy: TradingStrategy) {
    this.strategies.push(strategy);
  }

  async evaluateAll(context: StrategyContext): Promise<StrategyResult[]> {
    return Promise.all(this.strategies.map((s) => s.evaluate(context)));
  }

  // Returns the best strategy signal (highest score or first buy/sell)
  async getBestSignal(
    context: StrategyContext
  ): Promise<StrategyResult | null> {
    const results = await this.evaluateAll(context);
    // Prioritize shouldBuy/shouldSell, then by score
    const buy = results.find((r) => r.shouldBuy);
    const sell = results.find((r) => r.shouldSell);
    if (buy) return buy;
    if (sell) return sell;
    if (results.length > 0) {
      return results.reduce(
        (best, curr) =>
          curr.score && (!best || curr.score > best.score!) ? curr : best,
        null as any
      );
    }
    return null;
  }
}

export default new StrategyEngine();
