# Native Swap Engine — Compute-Unit Budgeting Spec

Status: draft. Documents the gap flagged in doc 13 point 4 and explicitly
left as a placeholder in `cpmm.ts`'s `buy()`/`sell()`
(`RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT ?? 300_000`) — a single hardcoded global
guess, not yet tuned from real usage.

## 1. Why this is a separate problem from the priority fee

`priorityFee.ts`-style tuning (still not built either, but a separate
concern) controls **price per compute unit** — how much you're willing to
pay per unit of compute, which is what actually competes for block space.
Compute-unit **limit** controls something different: how many units the
transaction is _allowed_ to use before it aborts with
`ComputeBudgetExceeded`.

These interact in a way that makes getting the limit wrong costly in both
directions:

- **Too low**: the transaction fails outright, on-chain, after already
  paying the network fee and (if it got far enough) partially executing
  before the CU ceiling hit — this is not a free retry, it's a paid failure.
- **Too high**: Solana's fee model charges `computeUnitLimit ×
computeUnitPriceMicroLamports ÷ 1,000,000` **regardless of how many units
  were actually consumed**. Requesting 400,000 CUs when the transaction
  only needs 120,000 means paying priority fee on 280,000 CUs of pure
  waste, every single trade. At sniping volume (many trades per hour) this
  compounds into a real, trackable cost — the same category of "small
  amount, adds up fast at this volume" as the ATA-rent point in the
  fund-safety spec.

A single global constant can't be right for both failure modes at once,
because the actual cost varies by what the transaction is doing.

## 2. What consumes compute in a CPMM buy/sell transaction

Rough breakdown, in the order instructions run (buy; sell is the same set,
reordered per `rebuildTransaction`'s prepend/append split):

| Instruction                                                              | Relative cost            | Notes                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ComputeBudgetProgram.setComputeUnitLimit` / `setComputeUnitPrice`       | negligible               | Two tiny instructions, not real compute — priced in transaction size, not CU.                                                                                                                                            |
| `createAssociatedTokenAccountIdempotentInstruction` (WSOL, output token) | small–moderate           | Meaningfully cheaper when the account already exists (idempotent no-op path) than on first creation. A buy's first-ever trade for a mint is the expensive case; a sell almost always hits the cheap already-exists path. |
| `SystemProgram.transfer` + `createSyncNativeInstruction` (WSOL wrap)     | small                    | Two simple, well-understood instructions.                                                                                                                                                                                |
| **The CPMM swap instruction itself**                                     | **the bulk of the cost** | Anchor-based CPI into the Raydium program, reserve math, fee calculation, token transfers on both sides. This is the instruction actually worth profiling — see §3.                                                      |
| `createCloseAccountInstruction` (WSOL unwrap, sell only)                 | small                    | Simple, well-understood.                                                                                                                                                                                                 |

The swap instruction dominates, and it's also the one most likely to
change cost between pool types (CPMM vs. AMM V4 vs. CLMM) — matching doc
13's framing that this wants **per-pool-type constants**, not one number
for the whole native engine.

## 3. Required implementation: measure, don't guess

Two viable strategies, not mutually exclusive:

### 3a. Pre-send simulation to read `unitsConsumed` (primary strategy)

`cpmm.ts` already calls `connection.simulateTransaction()` in the
`!useReal` (simulate-only) branch — it already gets a
`SimulatedTransactionResponse` back, which includes a `unitsConsumed`
field. The gap is that the **real-send path doesn't simulate first at
all** — it goes straight to `sendAndConfirmWithRetry` with the static
guess.

Required change: even when `USE_REAL_SWAP=true`, run one simulation pass
before the real send, read `unitsConsumed` from the result, and set the
actual `ComputeBudgetProgram.setComputeUnitLimit` for the real transaction
to `unitsConsumed × safetyMargin` (a multiplier — start around 1.2, i.e.
20% headroom — not a flat additive buffer, since the buffer needs to scale
with the instruction's own cost). This means:

- The compute-budget instruction inside `buildTx`'s closure can no longer
  be a constant baked in before the first simulate — it has to be
  determined once (from the simulation) and then held fixed across
  `sendAndConfirmWithRetry`'s retries for that same attempt (retries change
  blockhash and priority fee, not the instruction set being retried).
- This adds one RPC round-trip (`simulateTransaction`) before every real
  send. That's a real latency cost on a snipe bot where milliseconds
  matter — worth measuring against the alternative (§3b) once there's
  real data to compare.

### 3b. Per-pool-type constants, tuned from observed data (fallback / fast path)

Once §3a has been run enough times in practice (devnet first, then small
real trades) to have real `unitsConsumed` samples for CPMM buys and sells
specifically, those samples should be turned into hardcoded
`RAYDIUM_CPMM_BUY_COMPUTE_UNIT_LIMIT` /
`RAYDIUM_CPMM_SELL_COMPUTE_UNIT_LIMIT` constants (env-overridable, same
pattern as the current single guess) — set at, say, the 95th percentile of
observed consumption plus the same ~20% margin. This skips the extra
simulate round-trip on the hot path once the number is actually known,
rather than paying that latency cost on every trade forever.

**The right sequence is 3a first, 3b second** — you can't responsibly pick
a per-pool-type constant without having measured real consumption for that
pool type first. Skipping straight to 3b now would just be swapping one
guess (`300_000`) for a different unverified guess with more decimal
places of false confidence.

## 4. Pass/fail test

- [ ] A real (or devnet) CPMM buy transaction, run with the §3a
      simulate-first approach, never hits `ComputeBudgetExceeded`.
- [ ] The same transaction's actual `unitsConsumed` (visible in the
      transaction's on-chain metadata after confirmation, not just the
      pre-send simulation) is logged alongside its signature — this is
      the data §3b's constants get tuned from, so it needs to be captured
      from day one of devnet testing, not added later when someone
      remembers.
- [ ] Deliberately construct a transaction with an artificially low
      `computeUnitLimit` (e.g. 5,000) against a real pool and confirm it
      fails with `ComputeBudgetExceeded` rather than some other error —
      this confirms the failure mode actually looks the way this doc
      assumes, on the actual installed SDK/program versions.

## 5. Out of scope for this spec

- Priority-fee tuning (`computeUnitPriceMicroLamports`) — a related but
  separate lever, already has a placeholder
  (`RAYDIUM_CPMM_PRIORITY_FEE_MICROLAMPORTS`) and its own bump-on-retry
  logic in `sender.ts`; not repeated here.
- AMM V4 / CLMM compute costs — no executor exists for either yet. §2's
  table is CPMM-specific; a CLMM swap in particular is expected to cost
  meaningfully more (tick-array account resolution, per the fund-safety
  spec's earlier note on CLMM's complexity), and should get its own
  profiling pass when that executor is built, not inherit CPMM's numbers.
