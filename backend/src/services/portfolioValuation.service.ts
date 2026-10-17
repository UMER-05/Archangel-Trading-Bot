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
import { getCachedQuoteImpliedPriceSol } from "./jupiter.service.js";
import { getOnChainMintSupply } from "./tokenSafetyChecks.service.js";
import depositTrackerService from "./depositTracker.service.js";
import { isPlausiblePnl } from "./monitor.service.js";
import { isBotManagedOpenPosition } from "../utils/positionState.js";
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
  // Only positions the bot still holds. A position closed at a loss keeps a
  // positive netSol in the ledger (cost minus smaller proceeds), so filtering
  // on netSol alone re-priced every past losing trade on every dashboard
  // poll: ~9 Jupiter quotes per /api/stats call under a rate-limited key,
  // which is what pushed the request past the frontend's 30s timeout.
  const openPositions = positions.filter(
    (pos) => pos.avgBuyPrice && isBotManagedOpenPosition(pos),
  );
  const distinctMints = Array.from(
    new Set(openPositions.map((pos) => pos.token)),
  );
  // Cache-only: the position monitor keeps these prices fresh on its own
  // tick, so a dashboard poll never spends a Jupiter request (or waits on a
  // 429 backoff) here — see getCachedQuoteImpliedPriceSol.
  const priceEntries = await Promise.all(
    distinctMints.map(async (mint) => {
      const supplyInfo = await getOnChainMintSupply(mint);
      const price = supplyInfo.available
        ? getCachedQuoteImpliedPriceSol(mint, supplyInfo.decimals)
        : null;
      return [mint, price] as const;
    }),
  );
  const priceSolByMint = new Map(priceEntries);

  let unrealizedPnlSol = 0;
  for (const pos of openPositions) {
    const avgBuyPrice = pos.avgBuyPrice;
    if (!avgBuyPrice) continue; // already filtered above; narrows the type
    try {
      const currentPrice = priceSolByMint.get(pos.token);
      if (currentPrice) {
        // Same guard the position monitor applies: a reference quote that
        // implies a >9,900% gain is a bad quote (wrong decimals, dust route),
        // not a real price. Counting it once showed a 0.004 SOL position as
        // +112,000 SOL of portfolio value on the dashboard.
        const pnlPercent = (currentPrice - avgBuyPrice) / avgBuyPrice;
        if (!isPlausiblePnl(pnlPercent)) {
          log.warn(
            { wallet, token: pos.token.slice(0, 8), currentPrice, avgBuyPrice },
            "Implausible reference price — excluding this position from unrealized PnL",
          );
          continue;
        }
        unrealizedPnlSol +=
          (currentPrice - avgBuyPrice) * (pos.netSol / avgBuyPrice);
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
