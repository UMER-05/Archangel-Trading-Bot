// backend/src/services/stats.service.ts
//
// ONE definition of the dashboard's headline numbers. GET /api/stats and the
// socket's "stats:update" used to compute Portfolio Value / Total Profit
// differently (HTTP: deposits + realized + live unrealized; socket: SOL tied
// up in open positions / realized only), so every socket push made the cards
// jump to different figures until the next HTTP poll set them back.
import dbService from "./db.service.js";
import portfolioValuationService from "./portfolioValuation.service.js";

export type WalletStats = Awaited<ReturnType<typeof dbService.getStats>>;

export async function getWalletStats(wallet?: string): Promise<WalletStats> {
  const stats = await dbService.getStats(wallet);
  // getStats() is ledger-only (no live prices, no deposit total). With a
  // wallet, override the three headline fields with the real valuation:
  // total deposited into the custodial wallet + net PnL (realized + cached
  // live-priced unrealized). No wallet means nothing to look up.
  if (wallet) {
    const valuation =
      await portfolioValuationService.getPortfolioValuation(wallet);
    stats.portfolioValue = valuation.portfolioValue;
    stats.totalProfitSol = valuation.totalPnlSol;
    // valuation.totalPnlPercent is a whole percent (5.2 = +5.2%); this
    // payload's convention is a decimal fraction like every other PnL field
    // (the frontend multiplies by 100).
    stats.totalProfitPercent = valuation.totalPnlPercent / 100;
  }
  return stats;
}

export default { getWalletStats };
