// frontend/lib/positionSizing.ts
//
// The same split the backend uses to size every buy (backend
// src/utils/positionSizing.ts) — kept in step by hand and pinned by tests on
// both sides — so the dashboard can say, before anything trades, what the
// next position will be and why the bot would or wouldn't open one.
//
//   buy size = spendable / free slots      (free = max open - open now)
//
// where spendable = the wallet's balance less a small fee reserve — or, when
// the trader has set a TRADING BUDGET, the smaller of that and what's left of
// the budget's capital:
//
//   capital     = budget - realized losses since the budget was set
//   budget room = capital - cost of the positions currently open
//
// The capital only ever shrinks (a loss lowers it, a profit never raises it),
// so profits stay outside what the bot may trade: the "protected profit".
//
// What stops the bot opening another position is either every slot being in
// use ("at_capacity") or too little to fund one minimum-size position
// ("low_balance", limited by the wallet's cash or by the budget).

export interface SizingInput {
  balanceSol: number;
  openPositions: number;
  maxOpenPositions: number;
  minTradeSol: number;
  feeReserveSol: number;
  budgetSol?: number | null | undefined;
  deployedSol?: number | undefined;
  realizedLossSol?: number | undefined;
  fixedTradeAmountSol?: number | undefined;
}

export type LimitedBy = "balance" | "budget";

export type SizingResult =
  | {
      status: "ready";
      buySol: number;
      slotsUsed: number;
      freeSlots: number;
      limitedBy: LimitedBy;
    }
  | { status: "at_capacity"; openPositions: number; maxOpenPositions: number }
  | {
      status: "low_balance";
      spendableSol: number;
      neededSol: number;
      limitedBy: LimitedBy;
      neededBudgetSol?: number;
    };

/** Balance needed to open `slots` positions at the minimum size. */
export function minBalanceForSlots(
  slots: number,
  minTradeSol: number,
  feeReserveSol: number
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
 * is cash the bot may not touch — beyond the capital it may use and the fee
 * reserve — i.e. what can be withdrawn without cutting into the budget.
 */
export function budgetBreakdown(input: {
  cashSol: number;
  feeReserveSol: number;
  budgetSol: number | null | undefined;
  deployedSol: number;
  realizedLossSol?: number | undefined;
}): { capitalSol: number; budgetRoomSol: number; protectedProfitSol: number } {
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
    budget - Math.max(0, input.realizedLossSol ?? 0)
  );
  const budgetRoomSol = Math.max(
    0,
    capitalSol - Math.max(0, input.deployedSol)
  );
  const cashSpendable = Math.max(
    0,
    (Number.isFinite(input.cashSol) ? input.cashSol : 0) -
      Math.max(input.feeReserveSol, 0)
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
    return { status: "at_capacity", openPositions, maxOpenPositions };
  }

  const cashSpendable = Math.max(
    0,
    (Number.isFinite(balanceSol) ? balanceSol : 0) - feeReserveSol
  );
  const budget = usableBudget(input.budgetSol);
  const deployedSol = Math.max(0, input.deployedSol ?? 0);
  const realizedLossSol = Math.max(0, input.realizedLossSol ?? 0);
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
        status: "low_balance",
        spendableSol,
        neededSol: feeReserveSol + minTradeSol,
        limitedBy,
      };
    }
    if (spendableSol + 1e-9 < input.fixedTradeAmountSol) {
      return {
        status: "low_balance",
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
      status: "ready",
      buySol: input.fixedTradeAmountSol,
      slotsUsed: 1,
      freeSlots,
      limitedBy,
    };
  }

  // The epsilon stops 0.03 / 0.01 = 2.9999999999999996 costing a whole slot.
  const affordableSlots =
    minTradeSol > 0 ? Math.floor(spendableSol / minTradeSol + 1e-9) : freeSlots;
  const slotsUsed = Math.min(freeSlots, affordableSlots);

  if (slotsUsed < 1) {
    return {
      status: "low_balance",
      spendableSol,
      neededSol: minBalanceForSlots(1, minTradeSol, feeReserveSol),
      limitedBy,
      ...(limitedBy === "budget" && budget !== null
        ? { neededBudgetSol: deployedSol + realizedLossSol + minTradeSol }
        : {}),
    };
  }

  return {
    status: "ready",
    buySol: spendableSol / slotsUsed,
    slotsUsed,
    freeSlots,
    limitedBy,
  };
}

const fmt = (n: number) => Number(n.toFixed(4));

/** One line for the settings UI: what the split means for this balance. */
export function describeSizing(
  result: SizingResult | null,
  balanceSol: number | null,
  fixedTradeAmountSol?: number | null
): { tone: "ok" | "info" | "warn"; text: string } | null {
  if (!result) return null;
  if (result.status === "ready") {
    const partial =
      fixedTradeAmountSol == null && result.slotsUsed < result.freeSlots
        ? ` (${
            result.limitedBy === "budget" ? "the trading budget" : "the balance"
          } only funds ${result.slotsUsed} of ${result.freeSlots} free slots at the minimum size)`
        : "";
    return {
      tone: "ok",
      text:
        fixedTradeAmountSol != null
          ? `Fixed size: ${fmt(result.buySol)} SOL per trade${partial}.`
          : result.limitedBy === "budget"
          ? `≈ ${fmt(result.buySol)} SOL per position from your trading budget${partial}.`
          : `≈ ${fmt(result.buySol)} SOL per position from your ${
              balanceSol != null ? fmt(balanceSol) : "current"
            } SOL balance${partial}.`,
    };
  }
  if (result.status === "at_capacity") {
    return {
      tone: "info",
      text: `All ${result.maxOpenPositions} slots are in use right now — a new position opens when one closes.`,
    };
  }
  if (result.limitedBy === "budget") {
    return {
      tone: "info",
      text: `Your trading budget is fully at work — a new position opens when one closes${
        result.neededBudgetSol != null
          ? `, or raise the budget to at least ${fmt(result.neededBudgetSol)} SOL`
          : ""
      }. The rest of your wallet is protected.`,
    };
  }
  return {
    tone: "warn",
    text: `Low balance — your trading wallet needs at least ${fmt(
      result.neededSol
    )} SOL before the bot can open a position.`,
  };
}
