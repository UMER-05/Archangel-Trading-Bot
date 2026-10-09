# Native Swap Engine — WSOL, ATA, and Minimum-Out Fund-Safety Spec

Status: draft, pre-implementation review requested before `RAYDIUM_CPMM_EXECUTOR_ENABLED`
is ever set `true` outside devnet.

This covers the three categories of bug doc 13 (the second architecture
review) flagged as the ones most likely to cause a **silent fund-loss bug**
once we're constructing and signing our own Raydium transactions instead of
going through Jupiter's audited path: wrapped SOL handling, ATA creation,
and the minimum-output guard. It's written to be checked against, not just
read — each section ends with a concrete pass/fail test.

---

## 1. Wrapped SOL (WSOL)

### Why this needs its own section

Raydium pools trade SPL tokens. Native SOL is not an SPL token — it has to
become **wrapped SOL** (an SPL token account holding `So1111...1112`,
funded by a plain lamport transfer + `syncNative`) before it can be the
input side of a swap, and unwrapped back afterward. This is one of the most
common places hand-rolled Solana swap bots lose money or silently fail:

- **Buy side**: if the WSOL account isn't funded *and synced* before the
  swap instruction runs in the same transaction, the swap fails outright —
  the raw account balance and the SPL token balance can disagree until
  `syncNative` runs.
- **Sell side**: if the WSOL account is never closed after unwrapping, the
  ~0.00203928 SOL rent sits locked in a zero-balance account forever. At
  meme-coin sniping volume (many short-lived positions) this is a real,
  trackable drag on effective PnL (see doc 13, point 10) — not a rounding
  error to shrug off.

### What raydium-sdk-v2 does and doesn't do for us

`@raydium-io/raydium-sdk-v2`'s `cpmm.swap()` call accepts
`config: { associatedOnly, checkCreateATAOwner }` and internally detects
when one side of the pool is native SOL (`mintAUseSOLBalance` /
`mintBUseSOLBalance` in its own error messages), which suggests it *can*
build the wrap/unwrap instructions itself. **We should not rely on this
alone.** There is a documented case
([raydium-sdk-V2#107](https://github.com/raydium-io/raydium-sdk-V2/issues/107))
of the SDK throwing `"user do not have token account"` even with
`associatedOnly: false` set — i.e. the exact flag meant to prevent this
failed to, at least in that SDK version. We are not going to find out the
hard way whether that's fixed in whatever version we pin. Treat the SDK's
own WSOL/ATA handling as a **convenience, not a guarantee** — build our own
explicit wrap/unwrap and ATA instructions and prepend them to the
transaction ourselves, so the transaction's correctness doesn't depend on
an SDK internal we can't audit from here.

### Required implementation (`services/execution/transaction/wsol.ts`)

- `buildWrapSolInstructions(owner, lamports)` → returns, in order:
  1. `createAssociatedTokenAccountIdempotentInstruction` for the owner's
     WSOL ATA (`NATIVE_MINT`) — idempotent so it's a no-op if the account
     already exists from a prior trade.
  2. `SystemProgram.transfer` of `lamports` from the owner's wallet to that
     WSOL ATA.
  3. `createSyncNativeInstruction` on that ATA — this is what makes the
     transferred lamports visible as SPL token balance; skipping it is the
     single most common cause of "swap simulates fine, fails on send."
- `buildUnwrapSolInstructions(owner)` → returns a single
  `createCloseAccountInstruction` on the owner's WSOL ATA, which both
  converts the remaining WSOL back to native lamports **and** reclaims the
  account's rent to the owner in the same instruction. This must run as
  part of the sell transaction itself, not a separate follow-up tx — a
  follow-up tx is an extra round trip and an extra place for the "did it
  actually land" problem from doc 12's Phase 9 gap to bite.

### Pass/fail test

- [ ] A buy transaction against a pool with **zero prior WSOL balance** in
      the trading wallet succeeds on the first attempt (no separate
      wrap-then-swap transactions).
- [ ] A sell transaction leaves **no WSOL account** behind — verify via
      `getTokenAccountsByOwner` filtered to `NATIVE_MINT` after a sell,
      expect zero results, and confirm the rent lamports landed back in the
      wallet's main balance.

---

## 2. Associated Token Account (ATA) creation

### Why this needs its own section

A brand-new meme-coin buy almost always means the wallet has **no ATA for
that mint yet** — it was created in the same block the pool was. Doc 13
point 2: the ATA-creation instruction has to be in the **same transaction**
as the swap, not a prior one. A separate "create ATA, wait for
confirmation, then swap" flow is an extra round trip against a pool whose
liquidity might already be thinning by the time the second transaction
lands — exactly the kind of gap Phase 9's "pool state can change between
simulate and land" warning is about.

### Required implementation

- Every buy transaction prepends
  `createAssociatedTokenAccountIdempotentInstruction` for **both** sides of
  the swap the wallet might not already hold an account for: the output
  mint (the new token — always needed on a first buy) and, per §1, the WSOL
  ATA if paying with wrapped SOL.
- Idempotent, not the plain (non-idempotent) creation instruction: a
  duplicate/retried transaction attempt (see §3 and doc 12's sender-retry
  gap) must not fail with "account already exists" if the first attempt
  actually landed and we're re-simulating or retrying defensively.
- `checkCreateATAOwner: true` stays set on the SDK's own swap-instruction
  builder as a second, independent check — belt-and-suspenders, given §1's
  point that we don't fully trust the SDK's ATA path alone.

### Pass/fail test

- [ ] A buy against a mint the wallet has never held succeeds in one
      transaction with no prior "create account" transaction sent.
- [ ] Re-running the exact same buy instruction set against a wallet that
      **already has** the ATA (e.g. a retry after a slow-confirming first
      attempt) does not fail with an "account already in use" error.

---

## 3. Minimum-output guard

### Why this needs its own section

Doc 12's Phase 9 checklist — "expected output acceptable," "slippage
acceptable" — reads as pre-flight validation happening in our own code
before we send anything. That's necessary but **not sufficient**. The only
protection that actually exists once the transaction is on-chain is the
`minimumAmountOut` parameter baked into the Raydium swap instruction
itself. A simulation that looks fine, followed by an instruction built with
a too-loose or missing minimum-out, both "pass" the app-side checklist
while leaving the trade fully exposed to whatever happens between simulate
and land — a fast-draining pool, a sandwich attempt (see §4), a delayed
send during congestion.

### Required implementation

- `minimumAmountOut` is derived from `CurveCalculator.swap()`'s
  `outputAmount` (computed from the pool's **own** on-chain reserves at
  quote time, not an app-side estimate) with the configured slippage
  tolerance applied — this is what `raydium-sdk-v2`'s `cpmm.swap({ ...,
  slippage })` call does internally when it builds the instruction; our job
  is to make sure we're passing it a real, freshly-fetched slippage
  tolerance and never `0` or an omitted value.
- The app-side pre-flight check (liquidity, price impact, expected output)
  and the on-chain `minimumAmountOut` must be derived from the **same**
  pool-reserves read, immediately before building the transaction — not
  two separate reads that can disagree if a block landed in between.
- Log the actual `minimumAmountOut` value (in both raw lamports/token units
  and human-readable form) alongside every sent transaction's signature,
  specifically so a post-mortem on a bad fill can distinguish "the guard
  was set correctly and the trade was still bad" from "the guard was
  wrong."

### Pass/fail test

- [ ] Constructing a swap instruction with slippage `0.01` (1%) against a
      known pool state produces a `minimumAmountOut` that is verifiably
      ~1% below the simulated/expected output — not equal to it, not zero,
      not undefined.
- [ ] A transaction manually crafted to simulate a worse fill than
      `minimumAmountOut` allows is rejected on-chain (this is Raydium
      program behavior we're relying on, not our own code — the test here
      is confirming our instruction actually carries the parameter, e.g. by
      decoding the built instruction's data before signing and asserting
      the field is present and matches the computed value).

---

## 4. Explicitly out of scope for this spec

Carried over from doc 13 as real, separate work — not silently dropped,
just not this document:

- Compute unit budgeting (point 4) — own spec, since it needs real
  per-pool-type tuning data this repo doesn't have yet.
- MEV/sandwich exposure and Jito bundle routing (point 6) — a send-path
  decision, not a transaction-construction one; belongs with
  `transaction/sender.ts`.
- Program ID / pool-layout pinning — already covered by
  `services/execution/raydiumProgramIds.ts` and
  `poolVerification.service.ts`, not repeated here.
- Retry-vs-double-execution safety (doc 13 point 5) — belongs with the
  sender's retry strategy, not instruction construction.
