/**
 * Risk Management Engine
 *
 * POSITION SIZING: Risk Engine
 * - Max trade size is capped at 2% of portfolio equity for fixed/manual buys
 * - No arbitrary cap on simultaneous open positions by default (was
 *   hardcoded to 3 — that number had no basis in an actual risk model, it
 *   just silently stopped the bot from taking new qualifying trades once 3
 *   were open). The daily-loss circuit breaker applies to every buy; the
 *   per-trade size cap applies to fixed-size and manual buys. Balance/free-slot
 *   auto-sizing retains its existing behavior. Set MAX_OPEN_POSITIONS in .env
 *   if you actually want a server-wide cap.
 * - Max 6% daily loss
 * - Bot stops trading when limits hit
 */

import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { getBalanceInSol } from "./solana.service.js";

const log = getLogger("riskManagement");

// Configuration (can be overridden by environment variables)
const MAX_RISK_PER_TRADE_PCT = Number(process.env.MAX_RISK_PER_TRADE_PCT ?? 2); // 2%
// Unset/0 means "no cap" — the number of *qualifying* trades the bot can
// hold is bounded by real risk controls (position sizing, daily-loss limit,
// wallet balance), not by an arbitrary count.
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS ?? 0);
const MAX_DAILY_LOSS_PCT = Number(process.env.MAX_DAILY_LOSS_PCT ?? 6); // 6%

interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  currentRisk: {
    openPositions: number;
    dailyLossPct: number;
    portfolioValue: number;
    maxTradeSize: number;
  };
}

/**
 * Check if a trade is allowed based on risk management rules
 */
export interface CanExecuteTradeOptions {
  /**
   * The wallet that OWNS the position/trade history. Trades are recorded
   * against the owner wallet, while `walletAddress` (the hot wallet that
   * holds the funds) is what the balance is read from. They are the same
   * wallet for the operator, but different for every custodial user — and
   * without this the open-position and daily-loss checks looked for a user's
   * trades under their hot wallet's address, found none, and never enforced.
   */
  ownerWallet?: string;
  /**
   * Apply the per-trade cap (default true). Auto-buys using legacy
   * balance/free-slot sizing turn this off to preserve that sizing behavior;
   * fixed-size auto-buys and manual buys enforce the configured cap.
   */
  enforcePerTradeCap?: boolean;
  maxDailyLossPct?: number;
  maxRiskPerTradePct?: number;
}

export async function canExecuteTrade(
  tradeAmountSol: number,
  walletAddress: string,
  options: CanExecuteTradeOptions = {},
): Promise<RiskCheckResult> {
  try {
    const ownerWallet = options.ownerWallet ?? walletAddress;
    const enforcePerTradeCap = options.enforcePerTradeCap ?? true;
    const maxDailyLossPct =
      options.maxDailyLossPct ?? MAX_DAILY_LOSS_PCT;
    const maxRiskPerTradePct =
      options.maxRiskPerTradePct ?? MAX_RISK_PER_TRADE_PCT;

    // Scoped to this specific wallet — each user's exposure/risk state must
    // be independent. Without an owner here, one user's open positions
    // would count against (and could block) every other user's trades.
    const openPositions = await dbService.getOpenPositionCount(ownerWallet);

    // Check max open positions (0/unset = no cap)
    if (MAX_OPEN_POSITIONS > 0 && openPositions >= MAX_OPEN_POSITIONS) {
      log.warn(
        `Trade blocked: Max ${MAX_OPEN_POSITIONS} open positions reached (current: ${openPositions})`,
      );
      return {
        allowed: false,
        reason: `Maximum ${MAX_OPEN_POSITIONS} open positions already active`,
        currentRisk: {
          openPositions,
          dailyLossPct: 0,
          portfolioValue: 0,
          maxTradeSize: 0,
        },
      };
    }

    // Calculate daily loss
    const dailyLoss = await calculateDailyLoss(ownerWallet);
    // Measured against what the wallet actually OWNS — the SOL it holds plus
    // the cost of the positions it has open (see walletEquity) — not against
    // the SOL balance alone. The cash balance shrinks every time a position
    // opens, so a loss worth 2% of the wallet read as 6%+ as soon as a few
    // positions were open, and the breaker stopped new buys for the day.
    // (It also must not be "money committed to positions" alone —
    // dbService.getPortfolioPnL().totalInvestedSol is a running sum of past
    // buys, ~0 with few trades, which made every limit collapse to nothing.)
    const { equity: portfolioValue } = await walletEquity(
      ownerWallet,
      walletAddress,
    );
    const dailyLossPct =
      portfolioValue > 0 ? (dailyLoss / portfolioValue) * 100 : 0;

    // Check max daily loss
    if (dailyLossPct >= maxDailyLossPct) {
      log.warn(
        `Trade blocked: Max daily loss ${maxDailyLossPct}% reached (current: ${dailyLossPct.toFixed(
          2,
        )}%)`,
      );
      return {
        allowed: false,
        reason: `Daily loss limit reached: lost ${dailyLoss.toFixed(4)} SOL today, ${dailyLossPct.toFixed(
          1,
        )}% of the wallet's ${portfolioValue.toFixed(
          4,
        )} SOL (limit ${maxDailyLossPct}%) — new buys resume tomorrow`,
        currentRisk: {
          openPositions,
          dailyLossPct,
          portfolioValue,
          maxTradeSize: 0,
        },
      };
    }

    // Calculate max trade size (2% of portfolio)
    const maxTradeSize = (portfolioValue * maxRiskPerTradePct) / 100;

    // Callers size trades as exactly `balance * riskPct` before calling here, so a
    // legitimate trade should land right at maxTradeSize — but that's a different
    // formula (`(x * pct) / 100` vs `x * (pct / 100)`), which can disagree by a
    // sub-lamport floating-point rounding error on an otherwise-identical value.
    // A tiny relative tolerance absorbs that noise without loosening the real cap.
    if (enforcePerTradeCap && tradeAmountSol > maxTradeSize * (1 + 1e-6)) {
      log.warn(
        `Trade blocked: Amount ${tradeAmountSol} SOL exceeds max ${maxRiskPerTradePct}% risk (${maxTradeSize.toFixed(
          2,
        )} SOL)`,
      );
      return {
        allowed: false,
        reason: `Trade size ${tradeAmountSol} SOL exceeds ${maxRiskPerTradePct}% max risk (${maxTradeSize.toFixed(
          2,
        )} SOL)`,
        currentRisk: {
          openPositions,
          dailyLossPct,
          portfolioValue,
          maxTradeSize,
        },
      };
    }

    // All checks passed
    log.info(
      `Risk check PASSED: ${tradeAmountSol} SOL trade allowed | Open: ${openPositions}/${MAX_OPEN_POSITIONS} | Daily Loss: ${dailyLossPct.toFixed(
        2,
      )}%/${maxDailyLossPct}%`,
    );

    return {
      allowed: true,
      currentRisk: {
        openPositions,
        dailyLossPct,
        portfolioValue,
        maxTradeSize,
      },
    };
  } catch (err) {
    log.error(`Risk check failed: ${err}`);
    return {
      allowed: false,
      reason: `Risk check error: ${err}`,
      currentRisk: {
        openPositions: 0,
        dailyLossPct: 0,
        portfolioValue: 0,
        maxTradeSize: 0,
      },
    };
  }
}

/**
 * What a bot wallet actually owns: the SOL sitting in its trading wallet plus
 * the cost still tied up in its open positions. Positions are keyed by the
 * OWNER wallet; the cash balance lives at the trading (hot) wallet.
 */
export async function walletEquity(
  ownerWallet: string,
  hotWallet: string,
): Promise<{ cash: number; deployed: number; equity: number }> {
  const cash = await getBalanceInSol(hotWallet);
  const deployed = await dbService.getDeployedSol(ownerWallet);
  return { cash, deployed, equity: cash + deployed };
}

/**
 * Calculate total loss for today, scoped to one wallet — otherwise one
 * user's losses would trip the daily-loss circuit breaker for everyone.
 */
async function calculateDailyLoss(walletAddress: string): Promise<number> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const trades = await dbService.getTrades(500, false, walletAddress);

    // Filter trades from today
    const todayTrades = trades.filter(
      (t) => t.timestamp >= startOfDay && t.type === "sell",
    );

    // Sum up losses (negative pnlSol)
    const totalLoss = todayTrades
      .filter((t) => (t.pnlSol || 0) < 0)
      .reduce((sum, t) => sum + Math.abs(t.pnlSol || 0), 0);

    return totalLoss;
  } catch (err) {
    log.error(`Failed to calculate daily loss: ${err}`);
    return 0;
  }
}

/**
 * Get current risk status
 */
export async function getRiskStatus(
  ownerWallet: string,
  hotWallet: string = ownerWallet,
  limits: { maxDailyLossPct?: number } = {},
): Promise<{
  openPositions: number;
  maxOpenPositions: number;
  dailyLossSol: number;
  dailyLossPct: number;
  maxDailyLossPct: number;
  tradingAllowed: boolean;
  portfolioValue: number;
}> {
  const maxDailyLossPct = limits.maxDailyLossPct ?? MAX_DAILY_LOSS_PCT;
  const openPositions = await dbService.getOpenPositionCount(ownerWallet);

  // Same basis as canExecuteTrade: what the wallet owns (cash + open positions).
  const { equity: portfolioValue } = await walletEquity(ownerWallet, hotWallet);

  const dailyLossSol = await calculateDailyLoss(ownerWallet);
  const dailyLossPct =
    portfolioValue > 0 ? (dailyLossSol / portfolioValue) * 100 : 0;

  const tradingAllowed =
    (MAX_OPEN_POSITIONS <= 0 || openPositions < MAX_OPEN_POSITIONS) &&
    dailyLossPct < maxDailyLossPct;

  return {
    openPositions,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    dailyLossSol,
    dailyLossPct,
    maxDailyLossPct,
    tradingAllowed,
    portfolioValue,
  };
}

export default {
  canExecuteTrade,
  getRiskStatus,
};
