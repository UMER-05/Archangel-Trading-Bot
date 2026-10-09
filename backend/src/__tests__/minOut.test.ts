import BN from "bn.js";
import { computeMinimumAmountOut } from "../services/execution/transaction/minOut.js";

describe("computeMinimumAmountOut", () => {
  it("applies slippage as a proportional reduction of the expected output", () => {
    const expected = new BN(1_000_000);
    const minOut = computeMinimumAmountOut(expected, 0.01); // 1%
    expect(minOut.toString()).toBe("990000");
  });

  it("never equals the expected output for any nonzero slippage", () => {
    const expected = new BN(500_000);
    const minOut = computeMinimumAmountOut(expected, 0.005);
    expect(minOut.eq(expected)).toBe(false);
    expect(minOut.lt(expected)).toBe(true);
  });

  it("treats slippage 0 as a valid, zero-tolerance input rather than throwing", () => {
    // slippage === 0 means "the fill must match the quote exactly" — a
    // legitimate (if aggressive) choice, distinct from an omitted/undefined
    // slippage value, which the caller must never pass through silently.
    const expected = new BN(1_000_000);
    const minOut = computeMinimumAmountOut(expected, 0);
    expect(minOut.eq(expected)).toBe(true);
  });

  it("rejects an out-of-range slippage", () => {
    const expected = new BN(1_000_000);
    expect(() => computeMinimumAmountOut(expected, 1)).toThrow();
    expect(() => computeMinimumAmountOut(expected, -0.1)).toThrow();
  });
});
