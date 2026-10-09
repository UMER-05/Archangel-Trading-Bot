import { Server, Socket } from "socket.io";
import { getLogger } from "../utils/logger.js";
import { getLatestTokens } from "../services/tokenPrice.service.js";
import dbService from "../services/db.service.js";
import { poolMonitor } from "../services/poolMonitor.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import { verifyWalletAuth } from "../utils/walletAuth.js";
import { issueSocketToken, verifySocketToken } from "../utils/socketSession.js";
import { normalizeWalletAddress } from "../services/solana.service.js";
import {
  startWalletBalanceSync,
  stopWalletBalanceSync,
  updateWalletSocketId,
} from "../services/walletBalance.service.js";

const logger = getLogger("socket");

// In-memory map: wallet => socket.id for targeted messaging
const walletSocketMap = new Map<string, string>();

export function registerSocketHandlers(io: Server) {
  // Listen for pool availability events
  poolMonitor.on("poolAvailable", (data) => {
    const { tokenMint, wallet } = data;
    const socketId = walletSocketMap.get(wallet);

    if (socketId) {
      io.to(socketId).emit("poolAvailable", {
        tokenMint,
        message: `A Jupiter route is now available for token ${tokenMint.slice(
          0,
          8,
        )}...! You can now trade this token.`,
        timestamp: new Date().toISOString(),
      });

      logger.info(
        `Notified wallet ${wallet.slice(
          0,
          8,
        )}... that pool is available for ${tokenMint.slice(0, 8)}...`,
      );
    }
  });

  poolMonitor.on("monitoringTimeout", (data) => {
    const { tokenMint, wallet } = data;
    const socketId = walletSocketMap.get(wallet);

    if (socketId) {
      io.to(socketId).emit("poolMonitorTimeout", {
        tokenMint,
        message: `Monitoring timed out for token ${tokenMint.slice(
          0,
          8,
        )}... after 10 minutes. Pool may not be available yet.`,
        timestamp: new Date().toISOString(),
      });
    }
  });

  io.on("connection", async (socket: Socket) => {
    logger.info(`⚡ Socket connected: ${socket.id}`);

    /** INITIAL TOKEN SNAPSHOT */
    try {
      const snapshot = getLatestTokens();
      socket.emit("tokenFeed", { tokens: snapshot });
    } catch (err: any) {
      logger.warn(
        { err: err?.message },
        "Failed to send token snapshot on connect",
      );
    }

    /** INITIAL STATS SNAPSHOT */
    try {
      const stats = await dbService.getStats();
      socket.emit("stats:update", stats);
    } catch (err: any) {
      logger.warn("Failed broadcasting initial stats");
    }

    /** CONFIRM CONNECTION */
    socket.emit("connection", { status: "connected" });

    /**
     * WALLET IDENTIFICATION
     * Client registers this socket for one wallet's private events (its
     * trades, balance, buy-failure reasons, settings changes...).
     *
     * This MUST be authenticated. It used to accept any wallet address as-is,
     * so anyone could join any wallet's private room and read its activity,
     * and every unauthenticated identify started a 5-second RPC balance loop
     * — a cheap way to exhaust the RPC quota. Now the client proves control
     * of the wallet with either
     *   - { wallet, walletAuthTimestamp, walletAuthSignature }: the same
     *     signed message the REST API uses (utils/walletAuth.ts), or
     *   - { wallet, token }: a session token issued by a previous successful
     *     identify, so reconnects don't need another wallet popup
     *     (utils/socketSession.ts).
     * A successful signature identify is answered with a fresh token.
     */
    socket.on("identify", async (payload: any) => {
      try {
        const {
          wallet: claimedWallet,
          token,
          walletAuthTimestamp,
          walletAuthSignature,
          autoMode,
        } = payload || {};

        const reject = (error: string) => {
          // A socket that keeps failing is probing, not a dashboard that
          // needs to sign again — cut it off.
          socket.data.identifyFailures =
            (socket.data.identifyFailures ?? 0) + 1;
          logger.warn(
            {
              socketId: socket.id,
              error,
              failures: socket.data.identifyFailures,
            },
            "identify rejected",
          );
          socket.emit("identified", { success: false, error });
          if (socket.data.identifyFailures >= 5) socket.disconnect(true);
        };

        if (typeof claimedWallet !== "string" || !claimedWallet) {
          return reject("wallet_required");
        }

        let wallet: string;
        try {
          wallet = normalizeWalletAddress(claimedWallet);
        } catch {
          return reject("invalid_wallet");
        }

        let issued: { token: string; expiresAt: number } | undefined;
        if (!verifySocketToken(wallet, token)) {
          const verified = verifyWalletAuth({
            wallet,
            timestamp: walletAuthTimestamp,
            signature: walletAuthSignature,
          });
          if (!verified) return reject("auth_required");
          issued = issueSocketToken(wallet);
        }

        // Already identified as this wallet on this very socket (a dashboard
        // re-announcing itself): nothing to redo, just re-acknowledge.
        if (socket.data.wallet === wallet) {
          socket.emit("identified", {
            wallet,
            success: true,
            ...(issued && { token: issued.token, expiresAt: issued.expiresAt }),
          });
          return;
        }

        // Check if wallet was already mapped (reconnection)
        const existingSocketId = walletSocketMap.get(wallet);
        const isReconnect = existingSocketId && existingSocketId !== socket.id;

        // Map wallet to socket for targeted messages
        walletSocketMap.set(wallet, socket.id);
        socket.data.wallet = wallet;
        // traderConfig.service.ts broadcasts config changes via
        // io.to(walletAddress).emit(...) — that only reaches anyone if a
        // socket has actually joined a room by that name, which nothing did
        // until now.
        socket.join(wallet);

        // Update socket ID for existing wallet sync or start new sync
        if (isReconnect) {
          logger.info(
            `🔄 Wallet ${wallet.slice(
              0,
              8,
            )}... reconnected with new socket ${socket.id.slice(0, 8)}...`,
          );
          updateWalletSocketId(wallet, socket.id);
        } else {
          // Start continuous balance syncing for this wallet
          logger.info(
            `🆕 Starting balance sync for wallet ${wallet.slice(0, 8)}...`,
          );
          // The balance is always read server-side — a client-supplied
          // starting balance is no longer trusted or accepted.
          await startWalletBalanceSync(io, wallet, socket.id, {
            intervalMs: 5000, // Sync every 5 seconds
          });
        }

        // autoMode here is a legacy identify-handshake field, logged only.
        // Real settings persistence is REST-based —
        // POST/GET /api/user/settings (user.route.ts, db.service.ts's
        // userSettings collection) — and independent of this socket payload.

        logger.info(
          { wallet, autoMode: !!autoMode },
          `Socket identified for wallet`,
        );

        // Acknowledge identification (with a session token when this
        // identify was proven by signature, so the client can reconnect
        // without signing again).
        socket.emit("identified", {
          wallet,
          success: true,
          ...(issued && { token: issued.token, expiresAt: issued.expiresAt }),
        });
      } catch (err: any) {
        logger.error(
          { err: err?.message ?? String(err) },
          "identify event failed",
        );
        socket.emit("identified", { success: false, error: err?.message });
      }
    });

    /**
     * FRONTEND TRADE EVENTS → scoped to the sending socket's own identified
     * wallet (not a global broadcast — this is that wallet's own manual
     * trade, private the same as every other per-wallet activity), plus a
     * refreshed stats snapshot for that same wallet.
     */
    socket.on("tradeLog", async (payload) => {
      const wallet = socket.data?.wallet;
      logger.info({ wallet }, "📥 tradeLog received");
      emitToWalletOrGlobal(io, wallet, "tradeFeed", {
        ...payload,
        timestamp: new Date().toISOString(),
      });

      if (wallet) {
        const stats = await dbService.getStats(wallet);
        emitToWalletOrGlobal(io, wallet, "stats:update", stats);
      }
    });

    socket.on("trade:update", async (payload) => {
      const wallet = socket.data?.wallet;
      logger.info({ wallet }, "📡 trade:update received");
      emitToWalletOrGlobal(io, wallet, "tradeFeed", payload);

      if (wallet) {
        const stats = await dbService.getStats(wallet);
        emitToWalletOrGlobal(io, wallet, "stats:update", stats);
      }
    });

    // "tokenFeed" and "priceUpdate" used to be re-broadcast to EVERY
    // connected client exactly as a client sent them — so any visitor could
    // inject fake tokens and prices into every open dashboard. Only the
    // server emits those events now (tokenPrice / monitor services), so
    // there is deliberately no client -> everyone relay here.

    /**
     * FRONTEND CAN REQUEST CURRENT STATS — scoped to this socket's own
     * identified wallet (set by "identify", above). Unidentified (no wallet
     * connected) correctly gets back zeroed stats from getStats(undefined).
     */
    socket.on("stats:request", async () => {
      const stats = await dbService.getStats(socket.data?.wallet);
      socket.emit("stats:update", stats);
    });

    /**
     * PORTFOLIO P&L REQUEST — scoped to this socket's own identified wallet.
     * Was previously hardcoded to the operator's own P&L regardless of who
     * asked, which handed the operator's private numbers to any socket.
     */
    socket.on("pnl:request", async () => {
      try {
        const wallet = socket.data?.wallet;
        const portfolioPnL = wallet
          ? await dbService.getPortfolioPnL(wallet)
          : {
              totalInvestedSol: 0,
              totalReturnedSol: 0,
              unrealizedPnlSol: 0,
              realizedPnlSol: 0,
              totalPnlSol: 0,
              totalPnlPercent: 0,
              winningTrades: 0,
              losingTrades: 0,
              totalTrades: 0,
              winRate: 0,
              averageWinSol: 0,
              averageLossSol: 0,
              largestWinSol: 0,
              largestLossSol: 0,
              openPositionsValue: 0,
              closedPositionsValue: 0,
              roi: 0,
            };
        // See pnlBroadcaster.service.ts — "pnl:update" is reserved for
        // pnlTracker.service.ts's per-token PnLUpdate payload shape.
        socket.emit("portfolio:pnl:update", portfolioPnL);
      } catch (err: any) {
        logger.error("Failed to fetch portfolio P&L:", err?.message);
      }
    });

    /**
     * TOKEN P&L REQUEST — same reasoning as pnl:request above.
     */
    socket.on("pnl:tokens:request", async () => {
      try {
        const wallet = socket.data?.wallet;
        const tokenPnL = wallet ? await dbService.getTokenPnL(wallet) : [];
        socket.emit("pnl:tokens:update", tokenPnL);
      } catch (err: any) {
        logger.error("Failed to fetch token P&L:", err?.message);
      }
    });

    /**
     * WATCHLIST REQUEST
     */
    socket.on("watchlist:request", async () => {
      try {
        // Only the identified wallet's own list — the client-supplied
        // userId used to be trusted, letting any socket read anyone's.
        const watchlist = socket.data?.wallet
          ? await dbService.getWatchlist(socket.data.wallet)
          : [];
        socket.emit("watchlist:update", watchlist);
      } catch (err: any) {
        logger.error("Failed to fetch watchlist:", err?.message);
      }
    });

    /** DISCONNECT */
    socket.on("disconnect", (reason) => {
      const wallet = socket.data?.wallet;
      if (wallet) {
        // Stop balance syncing for this wallet
        stopWalletBalanceSync(wallet);
        walletSocketMap.delete(wallet);
        logger.info(
          `🛑 Wallet ${wallet.slice(
            0,
            8,
          )}... disconnected, balance sync stopped`,
        );
      }
      logger.warn(`❌ Disconnected: ${socket.id} (${reason})`);
    });

    socket.on("error", (err) =>
      logger.error("Socket error: " + (err?.message ?? String(err))),
    );
  });

  // Expose wallet socket map globally for other services to emit targeted messages
  (global as any).__walletSocketMap = walletSocketMap;
}

/**
 * Helper function to get socket ID for a specific wallet
 * Can be used by services to send targeted messages
 */
export function getSocketIdForWallet(wallet: string): string | undefined {
  return walletSocketMap.get(wallet);
}
