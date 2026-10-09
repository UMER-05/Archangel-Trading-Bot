// backend/src/services/walletBalance.service.ts
import { Server } from "socket.io";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getLogger } from "../utils/logger.js";
import { getConnection } from "./solana.service.js";

const log = getLogger("walletBalance");

interface WalletSync {
  wallet: string;
  socketId: string;
  lastBalance: number;
  initialBalance: number;
  interval: NodeJS.Timeout;
  isActive: boolean;
}

// Store active wallet syncs
const activeWalletSyncs = new Map<string, WalletSync>();

/**
 * Start continuous balance syncing for a connected wallet
 */
export async function startWalletBalanceSync(
  io: Server,
  wallet: string,
  socketId: string,
  opts?: { intervalMs?: number; initialBalance?: number }
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 5000; // Sync every 5 seconds by default

  // Stop existing sync if wallet already syncing
  if (activeWalletSyncs.has(wallet)) {
    log.info(
      `Stopping existing balance sync for wallet ${wallet.slice(0, 8)}...`
    );
    stopWalletBalanceSync(wallet);
  }

  try {
    // Get initial balance
    const connection = getConnection();
    const publicKey = new PublicKey(wallet);
    const balanceLamports = await connection.getBalance(publicKey);
    const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;

    const initialBal = opts?.initialBalance ?? balanceSOL;

    log.info(
      `🔄 Starting balance sync for wallet ${wallet.slice(0, 8)}... ` +
        `Initial: ${initialBal.toFixed(4)} SOL, Current: ${balanceSOL.toFixed(
          4
        )} SOL, ` +
        `Interval: ${intervalMs}ms`
    );

    // Emit initial balance
    io.to(socketId).emit("wallet:balance", {
      wallet,
      balance: balanceSOL,
      initialBalance: initialBal,
      timestamp: Date.now(),
    });

    // Create sync interval
    const interval = setInterval(async () => {
      try {
        const sync = activeWalletSyncs.get(wallet);
        if (!sync || !sync.isActive) {
          clearInterval(interval);
          return;
        }

        const balanceLamports = await connection.getBalance(publicKey);
        const currentBalance = balanceLamports / LAMPORTS_PER_SOL;

        // Only emit if balance changed
        if (Math.abs(currentBalance - sync.lastBalance) > 0.00001) {
          const pnlSOL = currentBalance - sync.initialBalance;
          const pnlPercent =
            sync.initialBalance > 0 ? (pnlSOL / sync.initialBalance) * 100 : 0;

          log.debug(
            `💰 Balance updated for ${wallet.slice(0, 8)}...: ` +
              `${currentBalance.toFixed(4)} SOL (${
                pnlPercent >= 0 ? "+" : ""
              }${pnlPercent.toFixed(2)}%)`
          );

          io.to(socketId).emit("wallet:balance", {
            wallet,
            balance: currentBalance,
            initialBalance: sync.initialBalance,
            pnl: {
              sol: pnlSOL,
              percent: pnlPercent,
            },
            timestamp: Date.now(),
          });

          // Update last balance
          sync.lastBalance = currentBalance;
        }
      } catch (err: any) {
        // fetch's TypeError wraps the real reason (ECONNRESET, ETIMEDOUT,
        // DNS failure, ...) in .cause — plain `${err}` interpolation drops
        // it, leaving only the unhelpful "TypeError: fetch failed".
        log.error(
          { err: err?.message ?? String(err), cause: err?.cause?.message ?? err?.cause },
          `Failed to sync balance for ${wallet.slice(0, 8)}...`
        );
      }
    }, intervalMs);

    // Store sync info
    activeWalletSyncs.set(wallet, {
      wallet,
      socketId,
      lastBalance: balanceSOL,
      initialBalance: initialBal,
      interval,
      isActive: true,
    });

    log.info(
      `✅ Balance sync started for ${wallet.slice(0, 8)}... (${
        activeWalletSyncs.size
      } active syncs)`
    );
  } catch (err: any) {
    log.error(
      { err: err?.message ?? String(err), cause: err?.cause?.message ?? err?.cause },
      `Failed to start balance sync for ${wallet.slice(0, 8)}...`
    );
    throw err;
  }
}

/**
 * Stop balance syncing for a wallet
 */
export function stopWalletBalanceSync(wallet: string): void {
  const sync = activeWalletSyncs.get(wallet);
  if (!sync) {
    return;
  }

  log.info(`🛑 Stopping balance sync for wallet ${wallet.slice(0, 8)}...`);

  sync.isActive = false;
  clearInterval(sync.interval);
  activeWalletSyncs.delete(wallet);

  log.info(
    `✅ Balance sync stopped for ${wallet.slice(0, 8)}... (${
      activeWalletSyncs.size
    } active syncs)`
  );
}

/**
 * Update socket ID for a wallet (when reconnecting)
 */
export function updateWalletSocketId(
  wallet: string,
  newSocketId: string
): void {
  const sync = activeWalletSyncs.get(wallet);
  if (sync) {
    sync.socketId = newSocketId;
    log.info(
      `🔄 Updated socket ID for wallet ${wallet.slice(
        0,
        8
      )}... → ${newSocketId.slice(0, 8)}...`
    );
  }
}

/**
 * Get active balance sync info for a wallet
 */
export function getWalletSyncInfo(wallet: string): WalletSync | undefined {
  return activeWalletSyncs.get(wallet);
}

/**
 * Get all active wallet syncs
 */
export function getAllActiveWalletSyncs(): Map<string, WalletSync> {
  return activeWalletSyncs;
}

/**
 * Stop all active wallet syncs (for graceful shutdown)
 */
export function stopAllWalletSyncs(): void {
  log.info(
    `🛑 Stopping all wallet balance syncs (${activeWalletSyncs.size} active)`
  );

  for (const [wallet, sync] of activeWalletSyncs.entries()) {
    sync.isActive = false;
    clearInterval(sync.interval);
  }

  activeWalletSyncs.clear();
  log.info("✅ All wallet balance syncs stopped");
}

export default {
  startWalletBalanceSync,
  stopWalletBalanceSync,
  updateWalletSocketId,
  getWalletSyncInfo,
  getAllActiveWalletSyncs,
  stopAllWalletSyncs,
};
