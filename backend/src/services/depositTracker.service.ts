// backend/src/services/depositTracker.service.ts
//
// Detects SOL deposited directly on-chain into each custodial hot wallet.
// DepositPanel.tsx only shows the wallet's address and tells the user to
// send SOL from any wallet — there's no app-orchestrated transaction to
// hook into, so this periodically scans each custodial wallet's new
// transaction signatures and classifies each one:
//   - already in `trades` (by signature)      -> our own buy/sell, skip
//   - already in `walletWithdrawals`           -> our own withdrawal, skip
//   - otherwise, if it credited SOL to the wallet -> a genuine deposit
// Only the custodial wallet's own server-held keypair can ever authorize an
// outgoing transfer from it, so anything left over that isn't a recognized
// trade/withdrawal and increases the balance can only be an external
// deposit.
import { Connection, PublicKey } from "@solana/web3.js";
import { Collection } from "mongodb";
import type { Server } from "socket.io";
import { getConnection } from "./solana.service.js";
import { getLogger } from "../utils/logger.js";
import { connect } from "./db.service.js";
import userWalletService, { UserWallet } from "./userWallet.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";

const log = getLogger("depositTracker");

export type WalletDeposit = {
  ownerWallet: string;
  hotWalletPublicKey: string;
  signature: string;
  amountSol: number;
  timestamp: Date;
};

let depositsCol: Collection<WalletDeposit> | null = null;
let userWalletsCol: Collection<any> | null = null;
let tradesCol: Collection<any> | null = null;
let withdrawalsCol: Collection<any> | null = null;

async function getCols() {
  if (!depositsCol || !userWalletsCol || !tradesCol || !withdrawalsCol) {
    const db = await connect();
    depositsCol = db.collection<WalletDeposit>("walletDeposits");
    userWalletsCol = db.collection("userWallets");
    tradesCol = db.collection("trades");
    withdrawalsCol = db.collection("walletWithdrawals");
    await depositsCol.createIndex({ signature: 1 }, { unique: true });
    await depositsCol.createIndex({ ownerWallet: 1 });
  }
  return {
    deposits: depositsCol!,
    userWallets: userWalletsCol!,
    trades: tradesCol!,
    withdrawals: withdrawalsCol!,
  };
}

/** Sum of every deposit ever detected for this wallet — read from our own
 * ledger (fast, no chain call), kept fresh by the periodic scan below. */
export async function getTotalDepositedSol(ownerWallet: string): Promise<number> {
  const { deposits } = await getCols();
  const docs = await deposits
    .find({ ownerWallet })
    .project<{ amountSol: number }>({ amountSol: 1 })
    .toArray();
  return docs.reduce((sum, d) => sum + d.amountSol, 0);
}

// Bounded per wallet per tick so one wallet's huge history can't starve the
// scan of every other wallet in the same interval — the cursor picks up the
// rest on the next tick.
const MAX_SIGNATURES_PER_SCAN = 50;

async function scanWallet(
  conn: Connection,
  uw: Pick<UserWallet, "ownerWallet" | "hotWalletPublicKey" | "lastScannedSignature">,
  io?: Server
): Promise<void> {
  const { deposits, trades, withdrawals, userWallets } = await getCols();
  const pubkey = new PublicKey(uw.hotWalletPublicKey);

  const sigInfos = await conn.getSignaturesForAddress(pubkey, {
    ...(uw.lastScannedSignature ? { until: uw.lastScannedSignature } : {}),
    limit: MAX_SIGNATURES_PER_SCAN,
  });
  if (sigInfos.length === 0) return;

  // Newest-first from the RPC; process oldest-first so a mid-scan failure
  // still leaves the cursor at a consistent, resumable point rather than
  // skipping over unprocessed older signatures.
  const ordered = [...sigInfos].reverse();
  let newestProcessed: string | undefined;

  for (const info of ordered) {
    const sig = info.signature;
    if (info.err) {
      newestProcessed = sig; // failed tx, no real balance change either way
      continue;
    }

    const [isTrade, isWithdrawal, alreadyRecorded] = await Promise.all([
      trades.findOne({ signature: sig }, { projection: { _id: 1 } }),
      withdrawals.findOne({ signature: sig }, { projection: { _id: 1 } }),
      deposits.findOne({ signature: sig }, { projection: { _id: 1 } }),
    ]);
    if (isTrade || isWithdrawal || alreadyRecorded) {
      newestProcessed = sig;
      continue;
    }

    try {
      const tx = await conn.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
      });
      const idx = tx?.transaction.message.accountKeys.findIndex(
        (k) => k.pubkey.toBase58() === uw.hotWalletPublicKey
      );
      if (tx?.meta && idx !== undefined && idx >= 0) {
        const pre = tx.meta.preBalances[idx] ?? 0;
        const post = tx.meta.postBalances[idx] ?? 0;
        const deltaLamports = post - pre;
        if (deltaLamports > 0) {
          const amountSol = deltaLamports / 1e9;
          try {
            await deposits.insertOne({
              ownerWallet: uw.ownerWallet,
              hotWalletPublicKey: uw.hotWalletPublicKey,
              signature: sig,
              amountSol,
              timestamp: tx.blockTime
                ? new Date(tx.blockTime * 1000)
                : new Date(),
            });
            log.info(
              { ownerWallet: uw.ownerWallet, signature: sig, amountSol },
              "Detected new deposit"
            );
            emitToWalletOrGlobal(io, uw.ownerWallet, "walletDeposit", {
              amountSol,
              signature: sig,
              message: `Deposit received: +${amountSol.toFixed(4)} SOL`,
            });
          } catch (err: any) {
            // Unique index on signature — a concurrent scan already
            // recorded this one; not an error.
            if (err?.code !== 11000) throw err;
          }
        }
      }
    } catch (err: any) {
      log.warn(
        { ownerWallet: uw.ownerWallet, signature: sig, err: err?.message },
        "Failed to inspect signature — stopping this wallet's scan early, will retry next tick"
      );
      // Don't advance the cursor past a signature we couldn't classify —
      // leaving it unprocessed means the next tick retries it instead of
      // silently skipping a possible deposit.
      break;
    }
    newestProcessed = sig;
  }

  if (newestProcessed) {
    await userWallets.updateOne(
      { ownerWallet: uw.ownerWallet },
      { $set: { lastScannedSignature: newestProcessed } }
    );
  }
}

let scanInterval: NodeJS.Timeout | null = null;

export function startDepositTracker(
  opts?: { intervalMs?: number },
  io?: Server
): void {
  const intervalMs = opts?.intervalMs ?? 60_000;
  const conn = getConnection();

  const tick = async () => {
    try {
      const wallets = await userWalletService.listAllUserWallets();
      for (const uw of wallets) {
        try {
          await scanWallet(conn, uw, io);
        } catch (err: any) {
          log.error(
            { ownerWallet: uw.ownerWallet, err: err?.message },
            "Deposit scan failed for this wallet — continuing with the rest"
          );
        }
      }
    } catch (err: any) {
      log.error({ err: err?.message }, "Deposit tracker tick failed");
    }
  };

  tick();
  scanInterval = setInterval(tick, intervalMs);
  log.info(`Deposit tracker started (interval: ${intervalMs}ms)`);
}

export function stopDepositTracker(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    log.info("Deposit tracker stopped");
  }
}

export default { startDepositTracker, stopDepositTracker, getTotalDepositedSol };
