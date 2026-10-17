# Devnet Smoke Test Guide

Resolves the "nothing has run against a real RPC yet" gap that's been
flagged since the buy-side executor was first scaffolded. Two scripts,
two different jobs — read this before running either.

## Why two stages, not one

The obvious plan — "run the whole buy() flow against a devnet Raydium
pool" — doesn't actually work as a complete test. Raydium's CPMM program
may or may not be deployed on devnet depending on when you're reading
this, and even where it is, real, currently-liquid devnet pools with
meaningful reserves are not reliably available the way mainnet pools are.
A devnet-only test would either fail for reasons that have nothing to do
with whether this codebase's logic is correct, or silently test against a
degenerate pool that doesn't resemble a real trade.

So this splits into what each environment is actually good for:

- **Stage A — devnet, real transactions** (`scripts/devnet-smoke-test.ts`):
  everything that doesn't need a real DEX pool — wallet signing, WSOL
  wrap/unwrap, idempotent ATA creation, the compute-unit probe, and
  `sender.ts`'s real send/confirm/retry logic. These are exactly the
  pieces the fund-safety spec and compute-unit spec are about, and devnet
  SOL is worthless, so this can run repeatedly with zero financial risk.
- **Stage B — mainnet, simulation only** (`scripts/mainnet-dry-run.ts`):
  the actual Raydium SDK integration — `getPoolInfoFromRpc`,
  `CurveCalculator.swapBaseInput`, `raydium.cpmm.swap()` — run against a
  REAL, currently-liquid mainnet pool, but with `USE_REAL_SWAP` forced to
  `"false"` in the script itself (not just relying on your `.env`), so
  nothing is ever actually sent and no funds ever move. This is the only
  environment where the SDK calls this project actually depends on can be
  exercised against real pool data.

Passing both stages is necessary before either `RAYDIUM_NATIVE_EXECUTION_ENABLED`
or `RAYDIUM_CPMM_EXECUTOR_ENABLED` should ever be set to `true` anywhere
that isn't itself a deliberate, small, manually-watched real trade. Neither
stage is a substitute for that first real trade being small and watched —
they're what should happen _before_ it, not instead of it.

## Running Stage A (devnet)

1. Generate or reuse a **dedicated devnet-only keypair** — never your real
   trading wallet's key, even though it's devnet:
   ```
   solana-keygen new -o devnet-smoke-test.json --no-bip39-passphrase
   solana airdrop 1 $(solana-keygen pubkey devnet-smoke-test.json) --url devnet
   ```
2. Run:
   ```
   DEVNET_SMOKE_TEST_SECRET_KEY="$(cat devnet-smoke-test.json)" \
     npx tsx scripts/devnet-smoke-test.ts
   ```
3. Expect five steps, each printing PASS or FAIL: connectivity/balance,
   WSOL wrap, idempotent ATA re-creation, compute-unit probe, WSOL unwrap.

The script refuses to run at all if the configured RPC URL doesn't contain
"devnet", unless you explicitly set
`DEVNET_SMOKE_TEST_I_KNOW_THIS_ISNT_DEVNET=true` — this exists so a
copy-pasted or misconfigured RPC URL can't quietly turn a "safe to run
repeatedly" script into one that sends real transactions on mainnet.

## Running Stage B (mainnet, simulate-only)

You need a **real, currently-liquid mainnet Raydium CPMM pool address**.
Find one via Raydium's own pool list, a DEX aggregator/explorer, or a
recent pool you already know about from testing discovery. This script
does not pick one for you — using a stale or wrong pool address will
correctly report failure (pool verification / pool-state fetch will fail),
which is itself a valid test of the failure path, but isn't what you want
for confirming the happy path works.

```
MAINNET_DRYRUN_SECRET_KEY="$(cat your-mainnet-wallet.json)" \
MAINNET_DRYRUN_POOL_ADDRESS=<pool pubkey> \
MAINNET_DRYRUN_MINT=<token mint address> \
MAINNET_DRYRUN_DEX=raydium-cpmm \
MAINNET_DRYRUN_AMOUNT_SOL=0.01 \
  npx tsx scripts/mainnet-dry-run.ts
```

The wallet needs a small SOL balance (~0.01 SOL) even though nothing gets
sent — `simulateTransaction` still checks fee-payer solvency as part of a
realistic simulation. This can be the same wallet you intend to eventually
trade with, since no funds leave it here.

A successful run means: pool state was fetched correctly, the swap quote
computed without error, and `raydium.cpmm.swap()` built a structurally
valid instruction set against real on-chain data. It does NOT mean the
transaction would confirm if actually sent — congestion, last-moment pool
state changes, and the open `isCreatorFeeOnInput` approximation (still
flagged in `cpmm.ts`) are all things simulation success doesn't rule out.

## What "passing both stages" does and doesn't prove

Does: the plumbing works end-to-end against real infrastructure, and the
SDK integration itself is structurally correct against real pool data.

Doesn't: that a real send will actually confirm under real network
conditions, that the compute-unit limit measured on one pool generalizes to
others, that the retry/double-execution guard behaves correctly under real
network flakiness rather than the mocked flakiness the unit tests
exercise, or that `isCreatorFeeOnInput`'s hardcoded `false` is actually
correct for the specific pool tested. The first real, small, watched trade
is still the real test — these scripts exist to make that first trade far
less likely to fail for a reason that had nothing to do with market
conditions.
