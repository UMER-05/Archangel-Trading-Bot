import {
  classifyPosition,
  deployedSolOf,
  realizedLossSolSince,
  isBotManagedOpenPosition,
  isOpenPosition,
} from "../utils/positionState.js";

describe("isOpenPosition", () => {
  it("is open while tokens remain and cost is outstanding", () => {
    expect(isOpenPosition({ netSol: 0.02, remainingPct: 100 })).toBe(true);
    expect(isOpenPosition({ netSol: 0.02, remainingPct: 40 })).toBe(true);
  });

  it("is closed once fully exited — even when a LOSS leaves netSol positive", () => {
    // bought 0.02 SOL, sold everything for 0.008: netSol stays +0.012 forever
    expect(isOpenPosition({ netSol: 0.012, remainingPct: 0 })).toBe(false);
  });

  it("is closed when a profitable exit leaves netSol negative", () => {
    expect(isOpenPosition({ netSol: -0.03, remainingPct: 0 })).toBe(false);
    expect(isOpenPosition({ netSol: -0.03 })).toBe(false);
  });

  it("falls back to the dust threshold when there is no remainingPct", () => {
    expect(isOpenPosition({ netSol: 0.01 })).toBe(true);
    expect(isOpenPosition({ netSol: 0.0001 })).toBe(false);
  });

  it("treats a non-finite netSol as closed", () => {
    expect(isOpenPosition({ netSol: NaN, remainingPct: 100 })).toBe(false);
  });
});

describe("isBotManagedOpenPosition", () => {
  it("excludes the user's own self-custody positions", () => {
    expect(
      isBotManagedOpenPosition({
        netSol: 0.05,
        remainingPct: 100,
        custody: "self",
      }),
    ).toBe(false);
    expect(
      isBotManagedOpenPosition({
        netSol: 0.05,
        remainingPct: 100,
        custody: "custodial",
      }),
    ).toBe(true);
    expect(
      isBotManagedOpenPosition({
        netSol: 0.05,
        remainingPct: 100,
        custody: null,
      }),
    ).toBe(true);
  });
});

describe("classifyPosition", () => {
  it("open: ledger open and tokens held (or not checked)", () => {
    expect(classifyPosition({ netSol: 0.05, remainingPct: 100 }, "12345")).toBe(
      "open",
    );
    expect(classifyPosition({ netSol: 0.05, remainingPct: 100 }, null)).toBe(
      "open",
    );
  });

  it("closed: fully exited, whatever the chain says", () => {
    expect(classifyPosition({ netSol: 0.012, remainingPct: 0 }, "0")).toBe(
      "closed",
    );
    expect(classifyPosition({ netSol: -1, remainingPct: 100 }, null)).toBe(
      "closed",
    );
  });

  it("ghost: ledger says open but the wallet holds nothing", () => {
    expect(classifyPosition({ netSol: 0.05, remainingPct: 100 }, "0")).toBe(
      "ghost",
    );
    expect(classifyPosition({ netSol: 0.05, remainingPct: 100 }, "000")).toBe(
      "ghost",
    );
  });
});

describe("deployedSolOf (capital at work)", () => {
  const pos = (over: any) => ({
    netSol: 0.05,
    remainingPct: 100,
    custody: "custodial" as const,
    boughtSol: 0.2,
    ...over,
  });

  it("counts what was spent on the part still held", () => {
    expect(
      deployedSolOf([pos({ boughtSol: 0.2, remainingPct: 100 })]),
    ).toBeCloseTo(0.2, 9);
    expect(
      deployedSolOf([pos({ boughtSol: 0.2, remainingPct: 40 })]),
    ).toBeCloseTo(0.08, 9);
  });

  it("does not count closed positions — including ones sold at a loss", () => {
    expect(deployedSolOf([pos({ remainingPct: 0, netSol: 0.12 })])).toBe(0);
  });

  it("does not count the user's own self-custody positions", () => {
    expect(deployedSolOf([pos({ custody: "self" })])).toBe(0);
  });

  it("adds positions up", () => {
    expect(
      deployedSolOf([pos({ boughtSol: 0.2 }), pos({ boughtSol: 0.3 })]),
    ).toBeCloseTo(0.5, 9);
  });

  it("falls back to netSol for legacy records with no boughtSol", () => {
    expect(
      deployedSolOf([pos({ boughtSol: undefined, netSol: 0.07 })]),
    ).toBeCloseTo(0.07, 9);
  });

  it("does not let a partially-sold-at-profit position look smaller than what it still costs", () => {
    // bought 0.2, sold 30% for 0.09 (a profit): netSol = 0.11 but the remaining 70% cost 0.14
    expect(
      deployedSolOf([pos({ boughtSol: 0.2, remainingPct: 70, netSol: 0.11 })]),
    ).toBeCloseTo(0.14, 9);
  });
});

describe("realizedLossSolSince", () => {
  const T0 = 1_000_000;
  const closed = (over: any) => ({
    netSol: 0.06,
    remainingPct: 0,
    custody: "custodial" as const,
    lastSellAt: new Date(T0 + 5_000),
    ...over,
  });

  it("counts the loss on a position closed after the budget was set", () => {
    expect(realizedLossSolSince([closed({})], T0)).toBeCloseTo(0.06, 9);
  });

  it("ignores profits — only losses lower the capital", () => {
    expect(realizedLossSolSince([closed({ netSol: -0.1 })], T0)).toBe(0);
  });

  it("ignores positions closed before the budget was set", () => {
    expect(
      realizedLossSolSince([closed({ lastSellAt: new Date(T0 - 1) })], T0),
    ).toBe(0);
  });

  it("ignores positions that are still open, and self-custody ones", () => {
    expect(realizedLossSolSince([closed({ remainingPct: 100 })], T0)).toBe(0);
    expect(realizedLossSolSince([closed({ custody: "self" })], T0)).toBe(0);
  });

  it("ignores a closed position with no recorded sale time", () => {
    expect(realizedLossSolSince([closed({ lastSellAt: null })], T0)).toBe(0);
  });

  it("adds several losses and lets a win elsewhere leave them untouched", () => {
    expect(
      realizedLossSolSince(
        [
          closed({ netSol: 0.06 }),
          closed({ netSol: 0.04 }),
          closed({ netSol: -0.5 }),
        ],
        T0,
      ),
    ).toBeCloseTo(0.1, 9);
  });

  it("accepts ISO strings and timestamps for the sale time", () => {
    expect(
      realizedLossSolSince(
        [
          closed({ lastSellAt: new Date(T0 + 1).toISOString() }),
          closed({ lastSellAt: T0 + 2 }),
        ],
        T0,
      ),
    ).toBeCloseTo(0.12, 9);
  });
});
