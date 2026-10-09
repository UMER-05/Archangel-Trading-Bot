// backend/src/utils/positionSizing.ts
//
// How the bot sizes a buy. Pure functions only (no DB, RPC or env access
// beyond sizingEnv()), so the rule is unit-tested in one place and shared by
// the buy pipeline (validationPipeline.service.ts, Stage 0) and the wallet
// status endpoint (userWallet.route.ts) — the two can never disagree about
// whether a wallet "can trade".
//
// THE RULE. A trader chooses "Max Open Positions" (N). The trading wallet's
// spendable balance is split evenly across the slots that are still free:
//
//     buy size = spendable balance / free slots      (free = N - open now)
//
// so $10 with N=5 opens five $2 positions: after the first buy there is $8
// left and 4 free slots, which is $2 again. As positions close, the slots
// free up and the recovered balance is re-split across them.
//
// What stops the bot from opening another position:
//   - all N slots are in use (AT_CAPACITY), or
//   - LOW BALANCE: what's left (after a small reserve for network fees and
//     token-account rent) can't fund even one position of MIN_AUTO_TRADE_SOL.
//
// If the balance can't fund every free slot at the minimum size, the split
// uses fewer slots (bigger positions) rather than refusing to trade: 0.04 SOL
// with a 0.01 SOL minimum and 0.01 SOL reserve opens up to three 0.01 SOL
// positions, not zero.
//
// TRADING BUDGET (optional). A trader can cap what the bot may have at work:
// the money it spends is then also limited to
//
//     budget room = budget - cost of the positions currently open
//
// so the budget is split across the slots exactly like the balance is, and
// anything the wallet holds beyond it — profits from closed positions, later
// deposits — is never touched by the bot. That leftover is the "protected
// profit" (see budgetBreakdown): still in the trading wallet, still the
// trader's, withdrawable at any time.
//
// The budget is a ceiling, and it only ever SHRINKS: a realized loss lowers the
// capital the bot may trade with, but a profit never raises it. Without that,
// the bot would refill a losing position's budget from the profit pool and a
// drawdown would eat profits already made — the very thing the budget is for.
//
//     capital     = budget - realized losses since the budget was set
//     budget room = capital - cost of the positions currently open

export const DEFAULT_MAX_OPEN_POSITIONS = 5;
export const MAX_OPEN_POSITIONS_LIMIT = 50;

export interface SizingInput {
  balanceSol: number;
  openPositions: number;
  maxOpenPositions: number;
  minTradeSol: number;
  feeReserveSol: number;
  /** Trading budget in SOL; null/undefined = no budget (use the whole balance). */
  budgetSol?: number | null | undefined;
  /** Cost of the positions open right now. Only used together with a budget. */
  deployedSol?: number | undefined;
  /** SOL lost on positions closed since the budget was set (see positionState). */
  realizedLossSol?: number | undefined;
  /** Exact buy size; unset keeps the existing balance/free-slots split. */
  fixedTradeAmountSol?: number | undefined;
}

/** What is capping the size: the wallet's cash, or the trading budget. */
export type LimitedBy = "balance" | "budget";

export type SizingResult =
  | {
      ok: true;
      buySol: number;
      /** How many equal positions the spendable balance is being split into. */
      slotsUsed: number;
      freeSlots: number;
      spendableSol: number;
      limitedBy: LimitedBy;
    }
  | {
      ok: false;
      code: "AT_CAPACITY";
      openPositions: number;
      maxOpenPositions: number;
    }
  | {
      ok: false;
      code: "LOW_BALANCE";
      freeSlots: number;
      spendableSol: number;
      /** Total balance at which one more position becomes possible. */
      neededSol: number;
      limitedBy: LimitedBy;
      /** With a budget that is the limit: the budget at which one more fits. */
      neededBudgetSol?: number;
    };

/** Runtime knobs; read at call time so tests and env changes are honored. */
export function sizingEnv(): { minTradeSol: number; feeReserveSol: number } {
  return {
    minTradeSol: Number(process.env.MIN_AUTO_TRADE_SOL ?? 0.003),
    // Kept back from sizing for network fees, token-account rent (~0.002 SOL
    // for each new token) and the fees to SELL later — a wallet spent down to
    // zero couldn't pay to exit its own positions.
    feeReserveSol: Number(process.env.TRADE_FEE_RESERVE_SOL ?? 0.01),
  };
}

/** A stored/entered value -> a usable slot count, falling back to the default. */
export function normalizeMaxOpenPositions(value: unknown): number {
  const fallback = Number(
    process.env.DEFAULT_MAX_OPEN_POSITIONS ?? DEFAULT_MAX_OPEN_POSITIONS,
  );
  const base =
    Number.isInteger(fallback) &&
    fallback >= 1 &&
    fallback <= MAX_OPEN_POSITIONS_LIMIT
      ? fallback
      : DEFAULT_MAX_OPEN_POSITIONS;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_OPEN_POSITIONS_LIMIT
  ) {
    return value;
  }
  return base;
}

/** Balance needed to open `slots` positions at the minimum size. */
export function minBalanceForSlots(
  slots: number,
  minTradeSol: number,
  feeReserveSol: number,
): number {
  return feeReserveSol + Math.max(0, slots) * minTradeSol;
}

function usableBudget(budgetSol: number | null | undefined): number | null {
  return typeof budgetSol === "number" &&
    Number.isFinite(budgetSol) &&
    budgetSol > 0
    ? budgetSol
    : null;
}

/**
 * Where a wallet's money stands against its trading budget. `protectedProfitSol`
 * is what the bot may not touch: cash beyond the budget room and the fee
 * reserve — what the trader can withdraw without cutting into the budget.
 * Both are 0-ish/irrelevant when there is no budget.
 */
export function budgetBreakdown(input: {
  cashSol: number;
  feeReserveSol: number;
  budgetSol: number | null | undefined;
  deployedSol: number;
  realizedLossSol?: number | undefined;
}): {
  /** The budget less realized losses: what the bot may have at work in total. */
  capitalSol: number;
  budgetRoomSol: number;
  protectedProfitSol: number;
} {
  const budget = usableBudget(input.budgetSol);
  if (budget === null) {
    return {
      capitalSol: Infinity,
      budgetRoomSol: Infinity,
      protectedProfitSol: 0,
    };
  }
  const capitalSol = Math.max(
    0,
    budget - Math.max(0, input.realizedLossSol ?? 0),
  );
  const budgetRoomSol = Math.max(
    0,
    capitalSol - Math.max(0, input.deployedSol),
  );
  const cashSpendable = Math.max(
    0,
    (Number.isFinite(input.cashSol) ? input.cashSol : 0) -
      Math.max(input.feeReserveSol, 0),
  );
  return {
    capitalSol,
    budgetRoomSol,
    protectedProfitSol: Math.max(0, cashSpendable - budgetRoomSol),
  };
}

export function computePositionSize(input: SizingInput): SizingResult {
  const { balanceSol, openPositions, maxOpenPositions } = input;
  const minTradeSol = Math.max(input.minTradeSol, 0);
  const feeReserveSol = Math.max(input.feeReserveSol, 0);

  const freeSlots = maxOpenPositions - openPositions;
  if (freeSlots <= 0) {
    return { ok: false, code: "AT_CAPACITY", openPositions, maxOpenPositions };
  }

  const cashSpendable = Math.max(
    0,
    (Number.isFinite(balanceSol) ? balanceSol : 0) - feeReserveSol,
  );
  const budget = usableBudget(input.budgetSol);
  const deployedSol = Math.max(0, input.deployedSol ?? 0);
  const realizedLossSol = Math.max(0, input.realizedLossSol ?? 0);
  // With a budget, the bot may spend only what's left of the capital (budget
  // less realized losses, less what's at work) — never more than the wallet
  // actually holds either.
  const capital =
    budget === null ? Infinity : Math.max(0, budget - realizedLossSol);
  const budgetRoom =
    budget === null ? Infinity : Math.max(0, capital - deployedSol);
  const spendableSol = Math.min(cashSpendable, budgetRoom);
  const limitedBy: LimitedBy =
    budgetRoom < cashSpendable ? "budget" : "balance";

  if (
    typeof input.fixedTradeAmountSol === "number" &&
    Number.isFinite(input.fixedTradeAmountSol) &&
    input.fixedTradeAmountSol > 0
  ) {
    if (input.fixedTradeAmountSol < minTradeSol) {
      return {
        ok: false,
        code: "LOW_BALANCE",
        freeSlots,
        spendableSol,
        neededSol: feeReserveSol + minTradeSol,
        limitedBy,
      };
    }
    if (spendableSol + 1e-9 < input.fixedTradeAmountSol) {
      return {
        ok: false,
        code: "LOW_BALANCE",
        freeSlots,
        spendableSol,
        neededSol: feeReserveSol + input.fixedTradeAmountSol,
        limitedBy,
        ...(limitedBy === "budget" && budget !== null
          ? {
              neededBudgetSol:
                deployedSol + realizedLossSol + input.fixedTradeAmountSol,
            }
          : {}),
      };
    }
    return {
      ok: true,
      buySol: input.fixedTradeAmountSol,
      slotsUsed: 1,
      freeSlots,
      spendableSol,
      limitedBy,
    };
  }

  // How many minimum-size positions the money can actually fund. The epsilon
  // stops 0.03 / 0.01 = 2.9999999999999996 from costing a whole slot.
  const affordableSlots =
    minTradeSol > 0 ? Math.floor(spendableSol / minTradeSol + 1e-9) : freeSlots;
  const slotsUsed = Math.min(freeSlots, affordableSlots);

  if (slotsUsed < 1) {
    return {
      ok: false,
      code: "LOW_BALANCE",
      freeSlots,
      spendableSol,
      neededSol: minBalanceForSlots(1, minTradeSol, feeReserveSol),
      limitedBy,
      ...(limitedBy === "budget" && budget !== null
        ? { neededBudgetSol: deployedSol + realizedLossSol + minTradeSol }
        : {}),
    };
  }

  return {
    ok: true,
    buySol: spendableSol / slotsUsed,
    slotsUsed,
    freeSlots,
    spendableSol,
    limitedBy,
  };
}
