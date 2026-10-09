// backend/src/utils/walletMutex.ts
//
// Serializes buy execution per wallet. Position sizing (validationPipeline.
// service.ts's runPipeline, invoked per wallet from multiUserExecution.
// service.ts's fan-out) reads a wallet's live balance and spends a
// percentage of it — if two candidate mints are being processed for the
// same wallet at nearly the same moment (two concurrent webhook deliveries,
// each clearing Phase 3/4 for a different token), both would read the same
// starting balance and size off it, risking a real on-chain overdraw once
// both swaps land.
//
// Rather than pre-splitting capital across concurrent candidates (arbitrary,
// and doesn't scale), each buy attempt for a given wallet is queued behind
// whichever one is already in flight for that same wallet. The second
// attempt only starts once the first has fully finished
// (including its balance-reducing swap), so it naturally sizes against
// whatever capital is actually left — a real, balance-aware split instead
// of a race.
const queues = new Map<string, Promise<unknown>>();

export function withWalletLock<T>(
  wallet: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = queues.get(wallet) ?? Promise.resolve();
  // Run fn only after `prior` settles, regardless of whether it resolved or
  // rejected — one wallet's failed buy must never permanently wedge the
  // queue for every buy after it.
  const run = prior.then(fn, fn);
  // Stored for the NEXT caller to chain behind; swallow this run's own
  // rejection here so the stored queue promise itself never rejects (that
  // would poison every future .then() on it) — the real result/error still
  // reaches whoever called withWalletLock, via the returned `run` promise.
  queues.set(
    wallet,
    run.catch(() => undefined),
  );
  return run;
}
