// backend/src/services/portfolioValuation.service.ts
//
// "Portfolio Value" for a wallet = total SOL ever deposited into its
// custodial hot wallet + net PnL (realized + unrealized). This is the
// wallet's own trading equity — separate from "Wallet Balance", which is
// just the connected wallet's own on-chain SOL balance (see
// frontend/hooks/useWallet.ts / components/ui/WalletBalance.tsx).
//
// db.service.ts's getPortfolioPnL() only has ledger data (no live prices),
// so unrealizedPnlSol there is always 0 — this is where that gets filled in
// with a real mark-to-market using each open position's live Jupiter price,
// the same calculation positions.route.ts already does per-position.
import dbService from "./db.service.js";
import { getQuoteImpliedPriceSol } from "./jupiter.service.js";
import { getOnChainMintSupply } from "./tokenSafetyChecks.service.js";
import depositTrackerService from "./depositTracker.service.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("portfolioValuation");

export interface PortfolioValuation {
  totalDepositedSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  // Return on deposited capital, not on invested-in-trades capital (that's
  // db.service.ts's PortfolioPnL.totalPnlPercent, a different, still-valid
  // metric of its own).
  totalPnlPercent: number;
  portfolioValue: number;
}

export async function getPortfolioValuation(
  wallet: string,
): Promise<PortfolioValuation> {
  const [pnl, positions, totalDepositedSol] = await Promise.all([
    dbService.getPortfolioPnL(wallet),
    dbService.getPositions(wallet),
    depositTrackerService.getTotalDepositedSol(wallet),
  ]);

  // Fair-value price per open position — a small reference Jupiter quote
  // (see getQuoteImpliedPriceSol's own doc comment for the tradeoff), the
  // only price source left in this codebase now that Birdeye has been
  // removed entirely. One call per distinct mint, deduped across
  // positions/wallets sharing the same token, run in parallel.
  const distinctMints = Array.from(
    new Set(
      positions
        .filter((pos) => pos.avgBuyPrice && pos.netSol > 0)
        .map((pos) => pos.token),
    ),
  );
  const priceEntries = await Promise.all(
    distinctMints.map(async (mint) => {
      const supplyInfo = await getOnChainMintSupply(mint);
      const price = supplyInfo.available
        ? await getQuoteImpliedPriceSol(mint, supplyInfo.decimals)
        : null;
      return [mint, price] as const;
    }),
  );
  const priceSolByMint = new Map(priceEntries);

  let unrealizedPnlSol = 0;
  for (const pos of positions) {
    if (!pos.avgBuyPrice || pos.netSol <= 0) continue;
    try {
      const currentPrice = priceSolByMint.get(pos.token);
      if (currentPrice) {
        unrealizedPnlSol +=
          (currentPrice - pos.avgBuyPrice) * (pos.netSol / pos.avgBuyPrice);
      }
    } catch (err: any) {
      log.warn(
        { wallet, token: pos.token.slice(0, 8), err: err?.message },
        "Failed to price an open position for unrealized PnL — excluding it from this snapshot",
      );
    }
  }

  const realizedPnlSol = pnl.realizedPnlSol;
  const totalPnlSol = realizedPnlSol + unrealizedPnlSol;
  const totalPnlPercent =
    totalDepositedSol > 0 ? (totalPnlSol / totalDepositedSol) * 100 : 0;

  return {
    totalDepositedSol,
    realizedPnlSol,
    unrealizedPnlSol,
    totalPnlSol,
    totalPnlPercent,
    portfolioValue: totalDepositedSol + totalPnlSol,
  };
}

export default { getPortfolioValuation };
