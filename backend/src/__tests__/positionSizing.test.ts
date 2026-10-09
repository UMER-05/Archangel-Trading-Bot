import {
  budgetBreakdown,
  computePositionSize,
  minBalanceForSlots,
  normalizeMaxOpenPositions,
  sizingEnv,
  DEFAULT_MAX_OPEN_POSITIONS,
} from "../utils/positionSizing.js";

const base = { minTradeSol: 0.01, feeReserveSol: 0 };

describe("computePositionSize", () => {
  it("splits the balance into N equal positions as slots fill up", () => {
    // $10 (here 10 SOL) with 5 slots -> five positions of 2.
    let balance = 10;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        ...base,
        balanceSol: balance,
        openPositions: open,
        maxOpenPositions: 5,
      });
      if (!r.ok) throw new Error(`expected a buy at slot ${open}`);
      sizes.push(r.buySol);
      balance -= r.buySol;
    }
    expect(sizes).toEqual([2, 2, 2, 2, 2]);
    expect(Math.round(balance * 1e9)).toBe(0);
  });

  it("stops with AT_CAPACITY once all N slots are open, whatever the balance", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 100,
      openPositions: 5,
      maxOpenPositions: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AT_CAPACITY");
  });

  it("keeps every slice the same size when a fee reserve is held back", () => {
    const reserve = 0.01;
    let balance = 10;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        minTradeSol: 0.01,
        feeReserveSol: reserve,
        balanceSol: balance,
        openPositions: open,
        maxOpenPositions: 5,
      });
      if (!r.ok) throw new Error("expected a buy");
      sizes.push(Number(r.buySol.toFixed(9)));
      balance -= r.buySol;
    }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe(1.998);
    // the reserve is still there at the end
    expect(Number(balance.toFixed(9))).toBe(reserve);
  });

  it("reports LOW_BALANCE when what's left can't fund one minimum position", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.015,
      openPositions: 2,
      maxOpenPositions: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "LOW_BALANCE") {
      expect(r.spendableSol).toBeCloseTo(0.005, 9);
      expect(r.neededSol).toBeCloseTo(0.02, 9);
    } else {
      throw new Error("expected LOW_BALANCE");
    }
  });

  it("uses fewer, larger positions when the balance can't fund every slot at the minimum", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.04,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.slotsUsed).toBe(3); // 0.03 spendable / 0.01 = 3 (not 2 from float noise)
    expect(r.buySol).toBeCloseTo(0.01, 9);
  });

  it("re-splits recovered balance across the slots that free up", () => {
    // 4 of 5 open, 3 SOL back in the wallet: one free slot gets all of it.
    const r = computePositionSize({
      ...base,
      balanceSol: 3,
      openPositions: 4,
      maxOpenPositions: 5,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.buySol).toBe(3);
    expect(r.freeSlots).toBe(1);
  });

  it("treats a non-finite balance as empty", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: NaN,
      openPositions: 0,
      maxOpenPositions: 5,
    });
    expect(r.ok).toBe(false);
  });

  it("uses an exact fixed amount instead of re-splitting as slots fill", () => {
    const r = computePositionSize({
      ...base,
      balanceSol: 1,
      openPositions: 3,
      maxOpenPositions: 5,
      fixedTradeAmountSol: 0.15,
    });
    if (!r.ok) throw new Error("expected a fixed-size buy");
    expect(r.buySol).toBe(0.15);
    expect(r.slotsUsed).toBe(1);
  });

  it("skips a fixed-size buy rather than silently reducing its amount", () => {
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 0.1,
      openPositions: 0,
      maxOpenPositions: 5,
      fixedTradeAmountSol: 0.15,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "LOW_BALANCE") {
      expect(r.neededSol).toBeCloseTo(0.16, 9);
    } else {
      throw new Error("expected LOW_BALANCE");
    }
  });
});

describe("minBalanceForSlots", () => {
  it("is the reserve plus the minimum for each slot", () => {
    expect(minBalanceForSlots(5, 0.01, 0.01)).toBeCloseTo(0.06, 9);
    expect(minBalanceForSlots(0, 0.01, 0.01)).toBeCloseTo(0.01, 9);
  });
});

describe("normalizeMaxOpenPositions", () => {
  const saved = process.env.DEFAULT_MAX_OPEN_POSITIONS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEFAULT_MAX_OPEN_POSITIONS;
    else process.env.DEFAULT_MAX_OPEN_POSITIONS = saved;
  });

  it("keeps a valid whole number", () => {
    expect(normalizeMaxOpenPositions(3)).toBe(3);
    expect(normalizeMaxOpenPositions(50)).toBe(50);
  });

  it("falls back to the default for anything unusable", () => {
    delete process.env.DEFAULT_MAX_OPEN_POSITIONS;
    for (const bad of [undefined, null, 0, -1, 2.5, 51, "3", NaN]) {
      expect(normalizeMaxOpenPositions(bad)).toBe(DEFAULT_MAX_OPEN_POSITIONS);
    }
  });

  it("honors DEFAULT_MAX_OPEN_POSITIONS from the environment", () => {
    process.env.DEFAULT_MAX_OPEN_POSITIONS = "8";
    expect(normalizeMaxOpenPositions(undefined)).toBe(8);
    process.env.DEFAULT_MAX_OPEN_POSITIONS = "999"; // invalid -> built-in default
    expect(normalizeMaxOpenPositions(undefined)).toBe(
      DEFAULT_MAX_OPEN_POSITIONS,
    );
  });
});

describe("sizingEnv", () => {
  it("reads the minimum trade and fee reserve from the environment", () => {
    const min = process.env.MIN_AUTO_TRADE_SOL;
    const reserve = process.env.TRADE_FEE_RESERVE_SOL;
    process.env.MIN_AUTO_TRADE_SOL = "0.02";
    process.env.TRADE_FEE_RESERVE_SOL = "0.05";
    try {
      expect(sizingEnv()).toEqual({ minTradeSol: 0.02, feeReserveSol: 0.05 });
    } finally {
      if (min === undefined) delete process.env.MIN_AUTO_TRADE_SOL;
      else process.env.MIN_AUTO_TRADE_SOL = min;
      if (reserve === undefined) delete process.env.TRADE_FEE_RESERVE_SOL;
      else process.env.TRADE_FEE_RESERVE_SOL = reserve;
    }
  });
});

describe("trading budget", () => {
  const b = { minTradeSol: 0.01, feeReserveSol: 0 };

  it("splits the BUDGET (not the whole wallet) across the slots", () => {
    // 5 SOL in the wallet but a 1 SOL budget over 5 slots: 0.2 SOL each, all five.
    let cash = 5;
    let deployed = 0;
    const sizes: number[] = [];
    for (let open = 0; open < 5; open++) {
      const r = computePositionSize({
        ...b,
        balanceSol: cash,
        openPositions: open,
        maxOpenPositions: 5,
        budgetSol: 1,
        deployedSol: deployed,
      });
      if (!r.ok) throw new Error("expected a buy");
      expect(r.limitedBy).toBe("budget");
      sizes.push(Number(r.buySol.toFixed(9)));
      cash -= r.buySol;
      deployed += r.buySol;
    }
    expect(sizes).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
  });

  it("never touches profits: a position closing in profit does not grow the next one", () => {
    // 1 SOL budget, 5 slots, everything deployed except slot 1.
    // Slot 1's position (cost 0.2) closes at +0.1: cash gets 0.3 back.
    let cash = 0.3; // 0.2 cost + 0.1 profit came back
    const deployed = 0.8; // the other four positions
    const r = computePositionSize({
      ...b,
      balanceSol: cash,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: deployed,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.buySol).toBeCloseTo(0.2, 9); // the same 0.2, not 0.3
    cash -= r.buySol;
    expect(cash).toBeCloseTo(0.1, 9); // the profit is still there, untouched
    expect(
      budgetBreakdown({
        cashSol: cash,
        feeReserveSol: 0,
        budgetSol: 1,
        deployedSol: 1,
      }).protectedProfitSol,
    ).toBeCloseTo(0.1, 9);
  });

  it("uses only what is left when losses have eaten into the budget", () => {
    // Closed at a loss: only 0.14 came back for a 0.2 position. Budget room is 0.2, cash is 0.14.
    const r = computePositionSize({
      ...b,
      balanceSol: 0.14,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 0.8,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.buySol).toBeCloseTo(0.14, 9);
    expect(r.limitedBy).toBe("balance");
  });

  it("a loss lowers the capital for good — it is NOT refilled from protected profits", () => {
    // 0.6 SOL of profit is sitting in the wallet (protected). A position then
    // closes at a loss: 0.14 back for a 0.2 cost => 0.06 lost. Cash is 0.74.
    // Without loss tracking the bot would refill the budget to 1.0 and spend 0.2
    // (using 0.06 of the profit); with it, capital is 0.94 so it spends 0.14.
    const r = computePositionSize({
      ...b,
      balanceSol: 0.74,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 0.8,
      realizedLossSol: 0.06,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.buySol).toBeCloseTo(0.14, 9);
    expect(r.limitedBy).toBe("budget");
    const same = computePositionSize({
      ...b,
      balanceSol: 0.74,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 0.8,
      realizedLossSol: 0,
    });
    if (!same.ok) throw new Error("expected a buy");
    expect(same.buySol).toBeCloseTo(0.2, 9); // (the behaviour losses-tracking prevents)
  });

  it("the capital can run out entirely, and the message says the budget is the limit", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 5,
      openPositions: 0,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 0,
      realizedLossSol: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "LOW_BALANCE") {
      expect(r.limitedBy).toBe("budget");
      expect(r.neededBudgetSol).toBeCloseTo(1.01, 9); // to trade again: cover the 1.0 lost + one position
    } else {
      throw new Error("expected LOW_BALANCE");
    }
  });

  it("stops, and says the BUDGET is the limit, once it is all at work — however much cash there is", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 10,
      openPositions: 4,
      maxOpenPositions: 5,
      budgetSol: 1,
      deployedSol: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "LOW_BALANCE") {
      expect(r.limitedBy).toBe("budget");
      expect(r.neededBudgetSol).toBeCloseTo(1.01, 9); // deployed + one minimum position
    } else {
      throw new Error("expected LOW_BALANCE");
    }
  });

  it("a budget smaller than one minimum position can't open anything", () => {
    const r = computePositionSize({
      ...b,
      balanceSol: 10,
      openPositions: 0,
      maxOpenPositions: 5,
      budgetSol: 0.005,
      deployedSol: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("with no budget (or an unusable one) the wallet balance is used as before", () => {
    for (const budgetSol of [null, undefined, 0, -1, NaN]) {
      const r = computePositionSize({
        ...b,
        balanceSol: 10,
        openPositions: 0,
        maxOpenPositions: 5,
        budgetSol,
      });
      if (!r.ok) throw new Error("expected a buy");
      expect(r.buySol).toBe(2);
      expect(r.limitedBy).toBe("balance");
    }
  });

  it("keeps the fee reserve out of what a budget can spend", () => {
    // Budget 1 but only 1.0 in the wallet and 0.01 reserve: spends 0.99, not 1.
    const r = computePositionSize({
      minTradeSol: 0.01,
      feeReserveSol: 0.01,
      balanceSol: 1,
      openPositions: 0,
      maxOpenPositions: 1,
      budgetSol: 1,
      deployedSol: 0,
    });
    if (!r.ok) throw new Error("expected a buy");
    expect(r.buySol).toBeCloseTo(0.99, 9);
  });
});

describe("budgetBreakdown", () => {
  it("protected profit is the cash beyond the budget room and the fee reserve", () => {
    const r = budgetBreakdown({
      cashSol: 1.5,
      feeReserveSol: 0.01,
      budgetSol: 1,
      deployedSol: 0.4,
    });
    expect(r.budgetRoomSol).toBeCloseTo(0.6, 9);
    expect(r.protectedProfitSol).toBeCloseTo(1.5 - 0.01 - 0.6, 9);
  });

  it("is zero when the cash is all inside the budget", () => {
    expect(
      budgetBreakdown({
        cashSol: 0.5,
        feeReserveSol: 0.01,
        budgetSol: 1,
        deployedSol: 0.4,
      }).protectedProfitSol,
    ).toBe(0);
  });

  it("everything spendable is protected when the budget is fully deployed", () => {
    expect(
      budgetBreakdown({
        cashSol: 0.3,
        feeReserveSol: 0.01,
        budgetSol: 1,
        deployedSol: 1,
      }).protectedProfitSol,
    ).toBeCloseTo(0.29, 9);
  });

  it("reports the capital left after realized losses, and profits never add to it", () => {
    const r = budgetBreakdown({
      cashSol: 2,
      feeReserveSol: 0,
      budgetSol: 1,
      deployedSol: 0.5,
      realizedLossSol: 0.2,
    });
    expect(r.capitalSol).toBeCloseTo(0.8, 9);
    expect(r.budgetRoomSol).toBeCloseTo(0.3, 9);
    expect(r.protectedProfitSol).toBeCloseTo(1.7, 9);
  });

  it("nothing is 'protected' when there is no budget", () => {
    expect(
      budgetBreakdown({
        cashSol: 5,
        feeReserveSol: 0.01,
        budgetSol: null,
        deployedSol: 0,
      }).protectedProfitSol,
    ).toBe(0);
  });
});
