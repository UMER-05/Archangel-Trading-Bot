// frontend/lib/globalSettings.ts
//
// One definition of the "Global Trading Settings" form — defaults, validation
// and the conversion to the PATCH payload — shared by
// components/trading/trader-config-modal.tsx and
// components/trading/risk-management-panel.tsx. Those two used to carry
// separate copies of this logic that had already drifted apart.
//
// The limits mirror what backend/src/routes/traderConfig.route.ts enforces
// (take profit and stop loss are decimals between 0 and 1, i.e. at most
// 100%). A value the server would reject is caught here, so the user sees why
// BEFORE saving instead of a save that silently doesn't happen.
import type { TraderConfig } from "@hooks/useTraderConfig";

type GlobalSettings = TraderConfig["globalSettings"];

export interface GlobalSettingsForm {
  minMarketCapSol: number;
  /** Percent as typed by the user: 10 means +10%. */
  takeProfitPct: number;
  /** Percent as typed by the user: 30 means -30%. */
  stopLossPct: number;
  /** "" = not set; stored as 0 (buy as soon as a token passes the checks). */
  minSecondsSinceLaunch: number | "";
  autoTradeEnabled: boolean;
  /**
   * How many positions the bot may hold at once. The trading wallet's balance
   * is split across them (balance / free slots), so this is a COUNT — not a
   * SOL amount.
   */
  maxOpenPositions: number;
  /**
   * Trading budget: when on, the bot may only have this much SOL at work, and
   * everything else in the trading wallet (profits, later deposits) is
   * protected and never traded. Off = the bot may use the whole wallet.
   */
  budgetEnabled: boolean;
  /** SOL; only meaningful while budgetEnabled. "" = not entered yet. */
  tradingBudgetSol: number | "";
  /** "" = unlimited. */
  maxTotalTrades: number | "";
  /** Blank keeps the existing balance/free-slots sizing behavior. */
  fixedTradeAmountSol: number | "";
  /** Percent typed by the user, converted to basis points for Jupiter. */
  slippagePct: number;
  priorityFeeSol: number;
  maxDailyLossPct: number;
  maxRiskPerTradePct: number;
}

export type GlobalSettingsErrors = Partial<
  Record<keyof GlobalSettingsForm, string>
>;

export const DEFAULT_GLOBAL_SETTINGS_FORM: GlobalSettingsForm = {
  minMarketCapSol: 3,
  takeProfitPct: 10,
  stopLossPct: 30,
  minSecondsSinceLaunch: "",
  autoTradeEnabled: false,
  // Matches the backend's default when a wallet has never chosen one.
  maxOpenPositions: 5,
  budgetEnabled: false,
  tradingBudgetSol: "",
  maxTotalTrades: "",
  fixedTradeAmountSol: "",
  slippagePct: 10,
  priorityFeeSol: 0.00003,
  maxDailyLossPct: 6,
  maxRiskPerTradePct: 2,
};

export const MAX_LAUNCH_AGE_SECONDS = 30 * 24 * 3600;
export const MAX_TOTAL_TRADES_LIMIT = 100000;
export const MAX_OPEN_POSITIONS_LIMIT = 50;
export const MAX_TRADING_BUDGET_SOL = 1_000_000;
export const MIN_FIXED_TRADE_SOL = 0.003;
// The backend checks a token's launch age once, a few seconds to ~40s after
// the pool appears, and never comes back to it. A minimum age above this
// therefore skips almost every token.
export const LAUNCH_AGE_WARN_SECONDS = 10;

const round = (n: number, digits: number) => Number(n.toFixed(digits));

// x * 100 turns 0.07 into 7.000000000000001; rounding keeps the form clean.
export const decimalToPercent = (d: number) => round(d * 100, 4);
export const percentToDecimal = (p: number) => round(p / 100, 6);

export function formFromSettings(
  g?: GlobalSettings | null
): GlobalSettingsForm {
  const d = DEFAULT_GLOBAL_SETTINGS_FORM;
  return {
    minMarketCapSol: g?.minMarketCapSol ?? d.minMarketCapSol,
    takeProfitPct:
      g?.takeProfitPct != null
        ? decimalToPercent(g.takeProfitPct)
        : d.takeProfitPct,
    stopLossPct:
      g?.stopLossPct != null ? decimalToPercent(g.stopLossPct) : d.stopLossPct,
    minSecondsSinceLaunch: g?.minSecondsSinceLaunch ?? "",
    autoTradeEnabled: g?.autoTradeEnabled ?? false,
    maxOpenPositions: g?.maxOpenPositions ?? d.maxOpenPositions,
    budgetEnabled:
      typeof g?.tradingBudgetSol === "number" && g.tradingBudgetSol > 0,
    tradingBudgetSol:
      typeof g?.tradingBudgetSol === "number" && g.tradingBudgetSol > 0
        ? g.tradingBudgetSol
        : "",
    maxTotalTrades: g?.maxTotalTrades ?? "",
    fixedTradeAmountSol:
      typeof g?.fixedTradeAmountSol === "number" &&
      g.fixedTradeAmountSol > 0
        ? g.fixedTradeAmountSol
        : "",
    slippagePct:
      g?.slippageBps != null ? round(g.slippageBps / 100, 2) : d.slippagePct,
    priorityFeeSol: g?.priorityFeeSol ?? d.priorityFeeSol,
    maxDailyLossPct: g?.maxDailyLossPct ?? d.maxDailyLossPct,
    maxRiskPerTradePct:
      g?.maxRiskPerTradePct ?? d.maxRiskPerTradePct,
  };
}

/**
 * Take profit / stop loss, as percentages. 0 would exit immediately (take
 * profit at break-even, stop loss on any dip) and the server rejects anything
 * above 100%. Shared with the per-token settings dialog.
 */
export function validateTakeProfitStopLoss(
  takeProfitPct: number,
  stopLossPct: number
): { takeProfitPct?: string; stopLossPct?: string } {
  const errors: { takeProfitPct?: string; stopLossPct?: string } = {};
  if (
    !Number.isFinite(takeProfitPct) ||
    takeProfitPct <= 0 ||
    takeProfitPct > 100
  ) {
    errors.takeProfitPct = "Enter a take profit above 0% and up to 100%";
  }
  if (!Number.isFinite(stopLossPct) || stopLossPct <= 0 || stopLossPct > 100) {
    errors.stopLossPct = "Enter a stop loss above 0% and up to 100%";
  }
  return errors;
}

export function validateGlobalSettings(
  f: GlobalSettingsForm
): GlobalSettingsErrors {
  const errors: GlobalSettingsErrors = {};

  if (!Number.isFinite(f.minMarketCapSol) || f.minMarketCapSol < 0) {
    errors.minMarketCapSol = "Enter a finite non-negative minimum market cap";
  }

  Object.assign(
    errors,
    validateTakeProfitStopLoss(f.takeProfitPct, f.stopLossPct)
  );

  if (f.minSecondsSinceLaunch !== "") {
    const v = Number(f.minSecondsSinceLaunch);
    if (!Number.isFinite(v) || v < 0 || v > MAX_LAUNCH_AGE_SECONDS) {
      errors.minSecondsSinceLaunch =
        "Enter 0 to 2,592,000 seconds (30 days), or leave blank";
    }
  }

  if (
    !Number.isInteger(f.maxOpenPositions) ||
    f.maxOpenPositions < 1 ||
    f.maxOpenPositions > MAX_OPEN_POSITIONS_LIMIT
  ) {
    errors.maxOpenPositions = `Enter a whole number from 1 to ${MAX_OPEN_POSITIONS_LIMIT}`;
  }

  if (f.budgetEnabled) {
    const v = f.tradingBudgetSol;
    if (
      v === "" ||
      !Number.isFinite(Number(v)) ||
      Number(v) <= 0 ||
      Number(v) > MAX_TRADING_BUDGET_SOL
    ) {
      errors.tradingBudgetSol =
        "Enter how much SOL the bot may trade with (more than 0)";
    }
  }

  if (f.maxTotalTrades !== "") {
    const v = f.maxTotalTrades;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
      errors.maxTotalTrades =
        "Enter a positive whole number, or leave blank for unlimited";
    } else if (v > MAX_TOTAL_TRADES_LIMIT) {
      errors.maxTotalTrades = "Must be 100000 or less";
    }
  }

  if (f.fixedTradeAmountSol !== "") {
    const amount = Number(f.fixedTradeAmountSol);
    if (
      !Number.isFinite(amount) ||
      amount < MIN_FIXED_TRADE_SOL ||
      amount > 1_000_000
    ) {
      errors.fixedTradeAmountSol =
        `Enter at least ${MIN_FIXED_TRADE_SOL} SOL, or leave blank to split by free slots`;
    }
  }
  if (
    !Number.isFinite(f.slippagePct) ||
    f.slippagePct < 0.1 ||
    f.slippagePct > 100
  ) {
    errors.slippagePct = "Enter slippage from 0.1% to 100%";
  }
  if (
    !Number.isFinite(f.priorityFeeSol) ||
    f.priorityFeeSol < 0 ||
    f.priorityFeeSol > 0.01
  ) {
    errors.priorityFeeSol = "Enter a priority fee from 0 to 0.01 SOL";
  }
  for (const [field, value] of [
    ["maxDailyLossPct", f.maxDailyLossPct],
    ["maxRiskPerTradePct", f.maxRiskPerTradePct],
  ] as const) {
    if (!Number.isFinite(value) || value < 0.1 || value > 100) {
      errors[field] = "Enter a risk limit from 0.1% to 100%";
    }
  }

  return errors;
}

export function hasErrors(errors: GlobalSettingsErrors): boolean {
  return Object.values(errors).some(Boolean);
}

// Below this a stop loss sits inside the normal price noise of a new token:
// just buying and then selling through a thin pool costs a few percent in
// price impact and fees, before the price has moved at all.
export const TIGHT_STOP_LOSS_PCT = 2;

/**
 * Non-blocking warning for a stop loss so tight it will fire on noise, and
 * whose actual exit will land well beyond it. (A typo like 0.5 for 50 is the
 * usual reason someone ends up here — the field is in percent.)
 */
export function stopLossWarning(f: GlobalSettingsForm): string | null {
  const v = f.stopLossPct;
  if (!Number.isFinite(v) || v <= 0 || v >= TIGHT_STOP_LOSS_PCT) return null;
  return `A ${v}% stop loss is inside the normal price noise of new tokens — it can trigger almost immediately, and the actual sale will usually land well below -${v}%. The field is in percent (30 means -30%).`;
}

/**
 * How the exit levels really behave — shown next to them so a sale that
 * doesn't land exactly on the level isn't a surprise. Take profit and stop
 * loss are market orders triggered by a price check, not limit orders.
 */
export const EXIT_FILL_NOTE =
  "No on-chain stop order is placed. Levels are checked about every 5 seconds and sold at market while the bot is running; price movement, slippage, thin liquidity, or downtime can change the fill or delay an exit.";

/** A non-blocking warning: valid, but very likely not what the user wants. */
export function launchAgeWarning(f: GlobalSettingsForm): string | null {
  if (f.minSecondsSinceLaunch === "") return null;
  const v = Number(f.minSecondsSinceLaunch);
  if (!Number.isFinite(v) || v <= LAUNCH_AGE_WARN_SECONDS) return null;
  return `Values above ${LAUNCH_AGE_WARN_SECONDS}s will skip most tokens: the bot checks each new token once, within seconds of launch, and doesn't come back to it. Leave blank to buy as soon as a token passes the checks.`;
}

export function toSettingsPayload(f: GlobalSettingsForm): GlobalSettings {
  return {
    minMarketCapSol: f.minMarketCapSol,
    takeProfitPct: percentToDecimal(f.takeProfitPct),
    stopLossPct: percentToDecimal(f.stopLossPct),
    minSecondsSinceLaunch:
      f.minSecondsSinceLaunch === "" ? 0 : Number(f.minSecondsSinceLaunch),
    autoTradeEnabled: f.autoTradeEnabled,
    maxOpenPositions: f.maxOpenPositions,
    // null turns the budget off (the server then lets the bot use the whole
    // wallet again); when on, the server stamps when it was set.
    tradingBudgetSol:
      f.budgetEnabled && f.tradingBudgetSol !== ""
        ? Number(f.tradingBudgetSol)
        : null,
    // null explicitly clears a previously-set cap (unlimited).
    maxTotalTrades: f.maxTotalTrades === "" ? null : f.maxTotalTrades,
    fixedTradeAmountSol:
      f.fixedTradeAmountSol === "" ? null : Number(f.fixedTradeAmountSol),
    slippageBps: Math.round(f.slippagePct * 100),
    priorityFeeSol: f.priorityFeeSol,
    maxDailyLossPct: f.maxDailyLossPct,
    maxRiskPerTradePct: f.maxRiskPerTradePct,
  };
}
