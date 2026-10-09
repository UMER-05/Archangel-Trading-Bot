// backend/src/services/pnlBroadcaster.service.ts
import { Server } from "socket.io";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";

const log = getLogger("pnlBroadcaster");

let broadcastInterval: NodeJS.Timeout | null = null;

/**
 * Start broadcasting P&L updates to all connected clients
 */
export function startPnLBroadcaster(
  io: Server,
  opts?: { intervalMs?: number }
) {
  const intervalMs = opts?.intervalMs ?? 30000; // Broadcast every 30 seconds by default

  log.info(`Starting P&L broadcaster (interval: ${intervalMs}ms)`);

  const broadcastPnL = async () => {
    try {
      // This periodically refreshes the operator's OWN P&L — its own
      // private activity, same as any custodial user's, so it only reaches
      // a socket that has identified as the operator's own wallet (see
      // emitToWalletOrGlobal), never every connected client.
      const portfolioPnL = await dbService.getPortfolioPnL(
        dbService.OPERATOR_WALLET
      );

      // Distinct event name from pnlTracker.service.ts's "pnl:update" —
      // that one is a per-token, per-position payload (PnLUpdate:
      // tokenMint/entryPrice/currentPrice/...) consumed by
      // useJupiterEvents.tsx, which keys its map off `tokenMint`. This is
      // portfolio-wide (PortfolioPnL: totalInvestedSol/...), no tokenMint
      // field — reusing the same event name meant every 30s broadcast here
      // overwrote that map's real per-token data under an "undefined" key.
      emitToWalletOrGlobal(
        io,
        dbService.OPERATOR_WALLET,
        "portfolio:pnl:update",
        portfolioPnL
      );

      log.debug("Broadcasted operator's portfolio P&L update");
    } catch (err: any) {
      log.error({ err: err?.message ?? String(err) }, "Error broadcasting P&L");
    }
  };

  // Run initial broadcast
  broadcastPnL();

  // Set up interval
  broadcastInterval = setInterval(broadcastPnL, intervalMs);
}

/**
 * Stop the P&L broadcaster
 */
export function stopPnLBroadcaster() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
    log.info("P&L broadcaster stopped");
  }
}
