// backend/src/services/execution/transaction/sender.ts
//
// Closes the gap doc 12 (first architecture review) flagged in Phase 9 and
// doc 13 sharpened in its point 5: "simulating first is good, but a fast pool
// can still change state between simulation and confirmation, or the
// transaction can just fail to land during congestion" — and the fix has to
// include a safety check against double-execution, not just a naive retry
// loop. A hand-built Raydium executor has none of Jupiter's own resilience
// (doc 13 point 12), so this is the replacement for that.
//
// What this deliberately does NOT do: decide whether a failed/ambiguous
// send should be retried as a NEW trade, adjust trade size, or alert anyone.
// It reports what happened to one transaction attempt as accurately as
// possible; the caller (cpmm.ts's buy(), and later sell()) decides what that
// means for the position.
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { getLogger } from "../../../utils/logger.js";

const LOG = getLogger("tx-sender");

export interface BuildTxParams {
  blockhash: string;
  lastValidBlockHeight: number;
  computeUnitPriceMicroLamports: number;
}

/**
 * Builds a fully signed transaction for one send attempt. Called fresh on
 * every attempt (including retries) so the blockhash and priority fee can
 * change without re-fetching pool state or re-running the swap quote —
 * those don't need to change between attempts a few seconds apart; the
 * blockhash and fee absolutely do.
 */
export type TxBuilder = (
  params: BuildTxParams,
) => Promise<VersionedTransaction>;

export interface SendAndConfirmOptions {
  /** Total attempts, including the first. Default 3. */
  maxAttempts?: number;
  /** How long to wait for confirmation before considering a retry, per attempt. Default 15s. */
  confirmTimeoutMs?: number;
  /** How often to poll getSignatureStatuses while waiting. Default 1s. */
  pollIntervalMs?: number;
  /** Priority fee (µ-lamports/CU) for the first attempt. */
  initialComputeUnitPriceMicroLamports: number;
  /** Multiplier applied to the priority fee on each retry. Default 1.5. */
  priorityFeeBumpMultiplier?: number;
  /**
   * How the raw transaction bytes actually get onto the network. Defaults
   * to a plain connection.sendRawTransaction() call — everything else in
   * this file (confirmation polling, retry, the double-execution guard) is
   * completely unaware of which transport is in use, since a landed
   * transaction is a landed transaction regardless of how it got there.
   * See docs/mev-jito-routing-spec.md for the Jito bundle transport this
   * was built to support, and why the signature is now derived from the
   * built transaction itself (below) rather than a transport's return
   * value — that's what makes this pluggable at all.
   */
  send?: (rawTx: Uint8Array) => Promise<void>;
}

export type SendAndConfirmResult =
  | { outcome: "confirmed"; signature: string; attempts: number }
  // The transaction landed on-chain and executed, but the program returned
  // an error (e.g. slippage guard tripped). This is NOT retryable as "the
  // same attempt again" — it already ran. Distinct from "unconfirmed."
  | { outcome: "reverted"; signature: string; error: string; attempts: number }
  // Every attempt was exhausted without ever observing confirmation OR a
  // revert. This is the genuinely ambiguous case: the last attempt's
  // transaction may still land later. Callers must treat this as "unknown,
  // reconcile before assuming no funds moved" — never as a clean failure.
  | {
      outcome: "unknown";
      lastSignature: string;
      reason: string;
      attempts: number;
    };

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether `signature` has already landed — confirmed or reverted —
 * without sending anything. This is the doc-13-point-5 guard: called
 * immediately before every retry, so a retry never fires against a
 * transaction that actually just confirmed slowly. Returns null if the
 * signature is still unseen by the cluster (safe to retry).
 */
async function checkExistingSignature(
  connection: Connection,
  signature: string,
): Promise<
  { outcome: "confirmed" } | { outcome: "reverted"; error: string } | null
> {
  const { value } = await connection.getSignatureStatuses([signature]);
  const status = value[0];
  if (!status) return null;
  if (status.err) {
    return { outcome: "reverted", error: JSON.stringify(status.err) };
  }
  if (
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
  ) {
    return { outcome: "confirmed" };
  }
  return null;
}

export async function sendAndConfirmWithRetry(
  connection: Connection,
  buildTx: TxBuilder,
  options: SendAndConfirmOptions,
): Promise<SendAndConfirmResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const bumpMultiplier = options.priorityFeeBumpMultiplier ?? 1.5;

  let computeUnitPriceMicroLamports =
    options.initialComputeUnitPriceMicroLamports;
  let lastSignature: string | undefined;

  const sendFn =
    options.send ??
    (async (raw: Uint8Array) => {
      await connection.sendRawTransaction(raw, {
        skipPreflight: true,
        preflightCommitment: "confirmed",
      });
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // The double-execution guard: before doing anything else on attempt 2+,
    // check whether the PREVIOUS attempt's signature actually landed while
    // we were waiting/deciding to retry. If it did, we're done — sending
    // another transaction now would risk two confirmed buys instead of one.
    if (attempt > 1 && lastSignature) {
      const existing = await checkExistingSignature(connection, lastSignature);
      if (existing?.outcome === "confirmed") {
        LOG.info(
          { signature: lastSignature, attempt },
          "Previous attempt actually confirmed while preparing a retry — not resending",
        );
        return {
          outcome: "confirmed",
          signature: lastSignature,
          attempts: attempt - 1,
        };
      }
      if (existing?.outcome === "reverted") {
        LOG.warn(
          { signature: lastSignature, attempt, error: existing.error },
          "Previous attempt reverted on-chain — not resending, this was not an unconfirmed-timeout",
        );
        return {
          outcome: "reverted",
          signature: lastSignature,
          error: existing.error,
          attempts: attempt - 1,
        };
      }
      // Still genuinely unseen — safe to build and send a new attempt.
    }

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const tx = await buildTx({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      computeUnitPriceMicroLamports,
    });

    // Derived from the transaction's own signature, not a transport's
    // return value — connection.sendRawTransaction happens to return the
    // signature too, but a Jito bundle submission returns a bundle ID
    // instead. Computing it ourselves here is what makes confirmation
    // (below) transport-agnostic.
    const signature = bs58.encode(tx.signatures[0]!);
    await sendFn(tx.serialize());
    lastSignature = signature;
    LOG.info(
      { signature, attempt, maxAttempts, computeUnitPriceMicroLamports },
      "Sent transaction, waiting for confirmation",
    );

    const deadline = Date.now() + confirmTimeoutMs;
    while (Date.now() < deadline) {
      const status = await checkExistingSignature(connection, signature);
      if (status?.outcome === "confirmed") {
        return { outcome: "confirmed", signature, attempts: attempt };
      }
      if (status?.outcome === "reverted") {
        return {
          outcome: "reverted",
          signature,
          error: status.error,
          attempts: attempt,
        };
      }
      await sleep(pollIntervalMs);
    }

    // Timed out this attempt without seeing confirmation or a revert.
    LOG.warn(
      { signature, attempt, confirmTimeoutMs },
      "No confirmation within timeout — will re-check before deciding to retry",
    );
    computeUnitPriceMicroLamports = Math.ceil(
      computeUnitPriceMicroLamports * bumpMultiplier,
    );
    // Loop continues; next iteration's top-of-loop guard re-checks
    // `lastSignature` before building/sending anything new.
  }

  // Exhausted maxAttempts. One last check on the final signature — it may
  // have landed in the brief window between the last poll and here.
  if (lastSignature) {
    const final = await checkExistingSignature(connection, lastSignature);
    if (final?.outcome === "confirmed") {
      return {
        outcome: "confirmed",
        signature: lastSignature,
        attempts: maxAttempts,
      };
    }
    if (final?.outcome === "reverted") {
      return {
        outcome: "reverted",
        signature: lastSignature,
        error: final.error,
        attempts: maxAttempts,
      };
    }
  }

  return {
    outcome: "unknown",
    lastSignature: lastSignature ?? "",
    reason: `Gave up after ${maxAttempts} attempts — last signature still unconfirmed, not confirmed reverted or confirmed landed. Reconcile before assuming no funds moved.`,
    attempts: maxAttempts,
  };
}
