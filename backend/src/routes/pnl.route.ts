import { Router, Request, Response } from "express";
import * as db from "../services/db.service.js";
import portfolioValuationService from "../services/portfolioValuation.service.js";

const router = Router();

// Returned when no wallet is connected — there's no specific identity to
// show P&L for, not even the operator's own (that's its own private
// activity now, visible only when it's the one actually connected). Zero-
// shaped rather than {} so the frontend renders "nothing" instead of NaN.
const EMPTY_PORTFOLIO_PNL: db.PortfolioPnL & {
  totalDepositedSol: number;
  portfolioValue: number;
} = {
  totalInvestedSol: 0,
  totalReturnedSol: 0,
  unrealizedPnlSol: 0,
  realizedPnlSol: 0,
  totalPnlSol: 0,
  totalPnlPercent: 0,
  winningTrades: 0,
  losingTrades: 0,
  totalTrades: 0,
  winRate: 0,
  averageWinSol: 0,
  averageLossSol: 0,
  largestWinSol: 0,
  largestLossSol: 0,
  openPositionsValue: 0,
  closedPositionsValue: 0,
  roi: 0,
  totalDepositedSol: 0,
  portfolioValue: 0,
};

/**
 * GET /api/pnl/portfolio
 * Get comprehensive portfolio P&L metrics
 */
router.get("/portfolio", async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string | undefined;
    if (!wallet) {
      return res.json({ success: true, data: EMPTY_PORTFOLIO_PNL });
    }
    const [pnl, valuation] = await Promise.all([
      db.getPortfolioPnL(wallet),
      portfolioValuationService.getPortfolioValuation(wallet),
    ]);
    res.json({
      success: true,
      // unrealizedPnlSol/totalPnlSol from getPortfolioPnL() are ledger-only
      // (no live prices) — overridden with the real, live-priced figures.
      // totalDepositedSol/portfolioValue are new: total SOL ever deposited
      // into the custodial wallet, and that deposit total plus net PnL.
      data: {
        ...pnl,
        unrealizedPnlSol: valuation.unrealizedPnlSol,
        totalPnlSol: valuation.totalPnlSol,
        totalDepositedSol: valuation.totalDepositedSol,
        portfolioValue: valuation.portfolioValue,
      },
    });
  } catch (err) {
    console.error("Error fetching portfolio P&L:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch portfolio P&L",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/pnl/tokens
 * Get P&L breakdown by token
 */
router.get("/tokens", async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string | undefined;
    if (!wallet) {
      return res.json({ success: true, data: [] });
    }
    const tokenPnL = await db.getTokenPnL(wallet);
    res.json({
      success: true,
      data: tokenPnL,
    });
  } catch (err) {
    console.error("Error fetching token P&L:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch token P&L",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * GET /api/pnl/history?days=30
 * Get P&L history over time (daily aggregation)
 */
router.get("/history", async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const wallet = req.query.wallet as string | undefined;
    if (!wallet) {
      return res.json({ success: true, data: [] });
    }
    const history = await db.getPnLHistory(days, wallet);
    res.json({
      success: true,
      data: history,
    });
  } catch (err) {
    console.error("Error fetching P&L history:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch P&L history",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

export default router;
