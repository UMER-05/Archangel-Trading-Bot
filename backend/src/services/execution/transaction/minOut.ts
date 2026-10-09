// backend/src/services/execution/transaction/minOut.ts
//
// See /docs/native-swap-fund-safety-spec.md §3. Deliberately duplicates
// (in our own, independently-testable code) the same minimumAmountOut
// formula raydium-sdk-v2 applies internally when it builds a swap
// instruction, so the executor can assert its own expectation against
// whatever the SDK actually produces before signing — catching a
// mismatched/omitted slippage parameter rather than trusting silently.
// This is NOT a substitute for the on-chain minimumAmountOut the SDK bakes
// into the instruction; it's a cross-check on top of it.
import BN from "bn.js";

/**
 * Applies `slippage` (e.g. 0.01 for 1%) to a swap's expected output amount.
 * Matches raydium-sdk-v2's own internal formula:
 *   outputAmount * (1 - slippage), expressed in integer basis points to
 *   avoid floating-point BN arithmetic.
 */
export function computeMinimumAmountOut(
  expectedOutputAmount: BN,
  slippage: number,
): BN {
  if (slippage < 0 || slippage >= 1) {
    throw new Error(
      `slippage must be in [0, 1) — got ${slippage}. A missing/zero ` +
        `slippage is not "no tolerance," it's "no protection."`,
    );
  }
  const slippageBps = Math.round((1 - slippage) * 10_000);
  return expectedOutputAmount.mul(new BN(slippageBps)).div(new BN(10_000));
}
