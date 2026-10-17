# Native Swap Engine — MEV / Jito Bundle Routing Decision

Status: decided and implemented for the send step only (see "What this
does NOT cover" at the end). Resolves doc 13 point 6: "MEV/sandwich
exposure changes materially once you're not going through Jupiter... This
needs an explicit decision: send through Jito bundles (or another
MEV-protected path) or accept the exposure knowingly. Not something to
discover after the fact."

## 1. The problem, stated plainly

`sender.ts` currently submits the signed swap transaction with a plain
`connection.sendRawTransaction()` call to whatever RPC endpoint is
configured. That transaction, and the wallet + amount it's trading, is
visible to that RPC's operator and to anyone watching the mempool/gossip
layer before it lands. A fresh meme-coin buy — large expected price impact,
predictable direction, no aggregator routing obscuring intent — is a
textbook sandwich target: a searcher can see it, front-run with their own
buy, let ours execute at the now-worse price, then sell into it. Jupiter's
own routing has some amount of MEV-awareness baked in that a bare
`sendRawTransaction` call does not.

## 2. The decision: Jito bundles, opt-in, one transaction per bundle

**Adopt Jito bundle submission as an alternative send transport, selected
by `RAYDIUM_SEND_STRATEGY` (`"rpc"` default / `"jito"`), additive to the
existing RPC path — not a replacement.** Same philosophy as every other
flag in this engine: ships off, reversible instantly by flipping one env
var back, and the existing RPC path is untouched code, not deleted.

Concretely:

- The already-built, already-signed swap transaction gets ONE extra
  instruction appended — a small SOL tip to a Jito tip account — and is
  submitted as a **single-transaction bundle** to Jito's Block Engine
  (`sendBundle`) instead of via `connection.sendRawTransaction`.
- Confirmation, retry, and the double-execution guard in `sender.ts` are
  **completely unchanged**. This only works because, once a bundle lands,
  its transaction is an entirely ordinary on-chain transaction with an
  ordinary signature — the same `getSignatureStatuses` polling loop that
  already exists confirms it. Jito's own bundle-status endpoints
  (`getBundleStatuses`) are not used for confirmation at all; they'd be a
  second, redundant thing to poll for information `sender.ts` can already
  get. There's a real engineering appeal to keeping the trusted,
  already-reviewed confirmation logic untouched rather than forking it per
  send strategy.

### Why NOT a multi-transaction bundle

Jito bundles support up to 5 transactions, executed atomically. That
matters for things like "arbitrage tx + liquidation tx must succeed
together." It does not add anything here: we only ever have one
transaction (the swap itself) that needs sending. A second transaction in
the bundle would only be useful if we wanted the tip to be a *separate*
transaction from the swap — which is worse, not better, since it adds a
second signature and a second thing that could independently fail. Putting
the tip instruction inside the same transaction as the swap is simpler and
is explicitly supported (see implementation notes below).

### Why NOT racing Jito and plain RPC simultaneously for the same attempt

Sending the same signed transaction down both paths at once sounds like
"best of both worlds," but it reintroduces exactly the double-execution
risk `sender.ts`'s guard exists to prevent — now with two independent
in-flight submissions of the identical signed bytes, each capable of
landing. Solana itself will only ever execute one of them once the same
signature lands (a duplicate submission of an already-landed signature is
a no-op, not a double-spend) — so this wouldn't cause a double-SPEND, but
it complicates reasoning about "which path actually got it there" for
minimal latency benefit, since bundle landing time is already fast when it
lands. Not pursued for this round; worth revisiting if devnet/small-trade
data shows Jito's landing rate alone is too low to rely on.

## 3. The real cost this decision accepts

- **Every Jito bundle attempt costs its own tip**, separate from the
  network's own priority fee. `sender.ts`'s retry-with-bumped-priority-fee
  loop already means each retry attempt costs more in priority fee; under
  the Jito strategy, each retry ALSO pays a fresh tip if it gets
  resubmitted as a new bundle, since an unlanded bundle's tip was never
  collected but a *new* bundle attempt is a new one. This is a real,
  compounding cost on top of what the RPC strategy's retries already cost
  — worth watching once there's real retry-frequency data.
- **Jito bundles only land when a Jito-running validator is the current
  leader.** That's the large majority of stake, not all of it. During the
  minority of slots where a non-Jito leader is producing, a bundle-only
  strategy has nothing landing at all for that window — this is exactly
  why this stays additive/flag-gated rather than becoming the only send
  path; a devnet/small-trade comparison of actual landing rates between
  the two strategies is real data this repo doesn't have yet.
- **One added external dependency**: Jito's Block Engine is a different
  service from the Solana RPC endpoint already configured. If it's
  unreachable, `sendViaJitoBundle` throws the same way a broken RPC call
  would — `sender.ts` does not automatically fall back mid-attempt to the
  plain RPC path (see "What this does NOT cover" below).

## 4. Implementation notes (what the code actually does)

- `services/execution/transaction/jitoSender.ts` — new module. Fetches
  live tip accounts via `getTipAccounts` (cached 60s), picks one at random
  per instruction build (spec-recommended, reduces contention across many
  bots hitting the same account), falls back to a hardcoded list of the 8
  well-known tip accounts if that fetch itself fails. Exposes
  `sendViaJitoBundle`, a `sender.ts`-compatible `SendTransport`.
- `sender.ts` gained an optional `send` transport in
  `SendAndConfirmOptions`, defaulting to the existing
  `connection.sendRawTransaction` behavior — everything else in that file
  is unchanged. The transaction's own signature is now derived directly
  from `tx.signatures[0]` (base58-encoded) before the transport is called,
  rather than trusting `sendRawTransaction`'s return value — this is what
  makes the confirmation loop transport-agnostic.
- `cpmm.ts`'s `buy()`/`sell()` append a tip instruction (only when
  `RAYDIUM_SEND_STRATEGY=jito`) to the same transaction, and pass
  `sendViaJitoBundle` as the `send` transport. The tip instruction is
  included in the compute-unit probe too (see
  `docs/compute-unit-budget-spec.md`), so the measured limit reflects the
  real, final instruction set.
- `RAYDIUM_JITO_TIP_LAMPORTS` (default 1,000 — the commonly-cited floor;
  see §3 on why this isn't free to bump carelessly on every retry) and
  `JITO_BLOCK_ENGINE_URL` (default `https://mainnet.block-engine.jito.wtf/api/v1/bundles`)
  are both env-configurable, same pattern as every other tunable in this
  engine.

## 5. What this does NOT cover — real, explicit gaps

- **No automatic fallback from Jito to plain RPC within a single failed
  attempt.** If `sendViaJitoBundle` throws (Block Engine unreachable, rate
  limited, malformed request), that failure propagates the same way a
  broken RPC call already does — it does not silently retry via the other
  transport. Building that would mean deciding a whole new failure-handling
  policy (doc 13's point 12 concern about needing real monitoring rather
  than assuming resilience) and belongs with whoever tunes this after
  seeing real Jito failure rates, not decided speculatively here.
- **No regional Block Engine selection.** Jito operates several regional
  endpoints (Amsterdam, Frankfurt, NY, Tokyo) in addition to the global
  `mainnet.block-engine.jito.wtf`; picking the lowest-latency one for this
  deployment's actual hosting region is a real optimization left for later,
  once there's a deployment region to optimize for.
- **Not applied to `monitor.service.ts`'s Jupiter-path sells.** This send
  strategy only affects the native CPMM path. Jupiter's own swap execution
  has its own transaction-sending internals this project doesn't control.