import { describe, it, expect } from "vitest";
import {
  budgetBreakdown,
  computePositionSize,
  minBalanceForSlots,
} from "../positionSizing";

const base = { minTradeSol: 0.01, feeReserveSol: 0 };

describe("computePositionSize (must match the backend rule)", () => {
  it("splits the balance into N equal positions as slots fill", () => {
    let balance = 10;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        ...base,
        balanceSol: balance,
        openPositions: open,
        maxOpenPositions: 5,
      });
      if (r.status !== "ready") throw new Error("expected ready");
      sizes.push(r.buySol);
      balance -= r.buySol;
    }
    expect(sizes).toEqual([2, 2, 2, 2, 2]);
  });

  it("is at capacity once every slot is open", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 100,
      openPositions: 5,
      maxOpenPositions: 5,
    });
    expect(r.status).toBe("at_capacity");
  });

  it("is low_balance when what's left can't fund one minimum position", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.015,
      openPositions: 2,
      maxOpenPositions: 5,
    });
    expect(r.status).toBe("low_balance");
    if (r.status === "low_balance") expect(r.neededSol).toBeCloseTo(0.02, 9);
  });

  it("uses fewer, larger positions when the balance can't fund every slot", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.04,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.slotsUsed).toBe(3);
    expect(r.buySol).toBeCloseTo(0.01, 9);
  });

  it("treats a non-finite balance as empty", () => {
    expect(
      computePositionSize({
        ...base,
        balanceSol: NaN,
        openPositions: 0,
        maxOpenPositions: 5,
      }).status
    ).toBe("low_balance");
  });

  it("keeps an explicit fixed buy amount as slots fill", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 1,
      openPositions: 3,
      maxOpenPositions: 5,
      fixedTradeAmountSol: 0.15,
    });
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.buySol).toBe(0.15);
  });

  it("does not shrink a fixed buy amount to fit the available balance", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.1,
      openPositions: 0,
      maxOpenPositions: 5,
      fixedTradeAmountSol: 0.15,
    });
    expect(r.status).toBe("low_balance");
    if (r.status === "low_balance") {
      expect(r.neededSol).toBeCloseTo(0.16, 9);
    }
  });
});

describe("minBalanceForSlots", () => {
  it("is the reserve plus the minimum for each slot", () => {
    expect(minBalanceForSlots(5, 0.01, 0.01)).toBeCloseTo(0.06, 9);
  });
});

import { describeSizing } from "../positionSizing";

describe("describeSizing", () => {
  it("says nothing when there is no result yet", () => {
    expect(describeSizing(null, 1)).toBeNull();
  });

  it("reports the per-position size", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 10,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    const d = describeSizing(r, 10);
    expect(d?.tone).toBe("ok");
    expect(d?.text).toContain("2 SOL per position");
  });

  it("describes a fixed amount as per-trade sizing", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 1,
      openPositions: 2,
      maxOpenPositions: 5,
      fixedTradeAmountSol: 0.15,
    });
    expect(describeSizing(r, 1, 0.15)?.text).toContain(
      "Fixed size: 0.15 SOL per trade"
    );
  });

  it("reports a full house as information, not an error", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 10,
      openPositions: 5,
      maxOpenPositions: 5,
    });
    expect(describeSizing(r, 10)?.tone).toBe("info");
  });

  it("reports low balance as a warning with the amount needed", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.01,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    const d = describeSizing(r, 0.01);
    expect(d?.tone).toBe("warn");
    expect(d?.text).toContain("0.02 SOL");
  });
});

describe("trading budget (must match the backend rule)", () => {
  const b = { minTradeSol: 0.01, feeReserveSol: 0 };

  it("splits the budget, not the whole wallet, across the slots", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 5,
      openPositions: 0,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 0,
    });
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.buySol).toBeCloseTo(0.2, 9);
    expect(r.limitedBy).toBe("budget");
  });

  it("a loss lowers the capital and is not refilled from protected profit", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 0.74,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 0.8,
      realizedLossSol: 0.06,
    });
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.buySol).toBeCloseTo(0.14, 9);
  });

  it("reports the budget as the limit once it is all at work", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 10,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 1,
    });
    expect(r.status).toBe("low_balance");
    if (r.status === "low_balance") {
      expect(r.limitedBy).toBe("budget");
      expect(r.neededBudgetSol).toBeCloseTo(1.01, 9);
    }
  });

  it("ignores an unusable budget", () => {
    for (const budgetSol of [null, undefined, 0, -1, NaN]) {
      const r = computePositionSize({
        ...b,
        balanceSol: 10,
        openPositions: 0,
        maxOpenPositions: 5,
        budgetSol,
      });
      if (r.status !== "ready") throw new Error("expected ready");
      expect(r.buySol).toBe(2);
    }
  });

  it("budgetBreakdown: protected profit is the cash beyond the capital's room", () => {
    const r = budgetBreakdown({
      cashSol: 2,
      feeReserveSol: 0,
      budgetSol: 1,
      deployedSol: 0.5,
      realizedLossSol: 0.2,
    });
    expect(r.capitalSol).toBeCloseTo(0.8, 9);
    expect(r.protectedProfitSol).toBeCloseTo(1.7, 9);
    expect(
      budgetBreakdown({
        cashSol: 5,
        feeReserveSol: 0.01,
        budgetSol: null,
        deployedSol: 0,
      }).protectedProfitSol
    ).toBe(0);
  });

  it("describes a fully-used budget as information, and protects the rest", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 10,
      openPositions: 2,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 1,
    });
    const d = describeSizing(r, 10);
    expect(d?.tone).toBe("info");
    expect(d?.text).toContain("protected");
  });
});
