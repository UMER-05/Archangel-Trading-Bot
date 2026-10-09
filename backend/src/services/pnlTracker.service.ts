import { getLogger } from "../utils/logger.js";
import { getQuoteImpliedPriceSol } from "./jupiter.service.js";
import { getOnChainMintSupply } from "./tokenSafetyChecks.service.js";
import { Server as SocketIOServer } from "socket.io";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";

const LOG = getLogger("pnl-tracker");

interface TrackedPosition {
  tokenMint: string;
  entryPrice: number;
  amount: number;
  wallet: string;
  entryTime: number;
}

/**
 * STAGE 7: LIVE P&L TRACKING
 * Continuously track unrealized P&L via a small Jupiter reference quote —
 * see getQuoteImpliedPriceSol's own doc comment for the exact tradeoff.
 * This used to go through Birdeye, which has been removed from this
 * codebase entirely; there's no price-impact/liquidity-movement/soft-rug
 * enrichment left to attach here (that was Birdeye-specific data with no
 * equivalent from a quote alone), so this reports price and PnL only.
 */
class PnLTrackerService {
  // Keyed by "wallet:tokenMint", not tokenMint alone — different wallets
  // can independently hold a position in the same token, and a bare-token
  // key would let one wallet's tracked position silently overwrite (or get
  // stopped by) another's.
  private trackedPositions: Map<string, TrackedPosition> = new Map();
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds
  private io: SocketIOServer | null = null;

  private key(wallet: string, tokenMint: string): string {
    return `${wallet}:${tokenMint}`;
  }

  /**
   * Set Socket.IO server for broadcasting
   */
  setSocketIO(io: SocketIOServer): void {
    this.io = io;
    LOG.info("Socket.IO connected to P&L tracker");
  }

  /**
   * Start tracking a position
   */
  startTracking(position: TrackedPosition): void {
    LOG.info(
      { wallet: position.wallet },
      `📊 Started tracking P&L for ${position.tokenMint.slice(0, 8)}`,
    );
    this.trackedPositions.set(
      this.key(position.wallet, position.tokenMint),
      position,
    );

    // Start tracking loop if not already running
    if (!this.trackingInterval) {
      this.startTrackingLoop();
    }
  }

  /**
   * Stop tracking a position
   */
  stopTracking(tokenMint: string, wallet: string): void {
    LOG.info(
      { wallet },
      `🛑 Stopped tracking P&L for ${tokenMint.slice(0, 8)}`,
    );
    this.trackedPositions.delete(this.key(wallet, tokenMint));

    // Stop tracking loop if no positions left
    if (this.trackedPositions.size === 0 && this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
  }

  /**
   * Get all tracked positions
   */
  getTrackedPositions(): TrackedPosition[] {
    return Array.from(this.trackedPositions.values());
  }

  /**
   * Main tracking loop
   */
  private startTrackingLoop(): void {
    LOG.info("🔄 Starting P&L tracking loop...");

    this.trackingInterval = setInterval(async () => {
      // Iterate values only — the Map key is "wallet:tokenMint" for
      // uniqueness, not a usable mint address on its own.
      for (const position of this.trackedPositions.values()) {
        try {
          const supplyInfo = await getOnChainMintSupply(position.tokenMint);
          if (!supplyInfo.available) {
            LOG.debug(
              `Decimals unavailable for ${position.tokenMint.slice(0, 8)} — skipping this tick`,
            );
            continue;
          }
          const currentPrice = await getQuoteImpliedPriceSol(
            position.tokenMint,
            supplyInfo.decimals,
          );
          if (!currentPrice) {
            LOG.debug(
              `No Jupiter route/price for ${position.tokenMint.slice(0, 8)} — skipping this tick`,
            );
            continue;
          }

          // Broadcast to frontend via WebSocket
          this.broadcastPnLUpdate(position.tokenMint, position, currentPrice);
        } catch (error: any) {
          LOG.error(
            `Error tracking P&L for ${position.tokenMint.slice(0, 8)}: ${error.message}`,
          );
        }
      }
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Broadcast P&L update to frontend
   */
  private broadcastPnLUpdate(
    tokenMint: string,
    position: TrackedPosition,
    currentPrice: number,
  ): void {
    const percentChange =
      ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const update = {
      tokenMint,
      wallet: position.wallet,
      entryPrice: position.entryPrice,
      currentPrice,
      amount: position.amount,
      unrealizedPnL: (currentPrice - position.entryPrice) * position.amount,
      percentChange,
      timestamp: Date.now(),
    };

    // Only this position's own owner wallet (or everyone, for the shared
    // operator bot) — see walletSocket.ts.
    emitToWalletOrGlobal(this.io, position.wallet, "pnl:update", update);

    // Log significant changes
    if (Math.abs(percentChange) > 10) {
      LOG.info(
        `📈 Significant P&L change for ${tokenMint.slice(
          0,
          8,
        )}: ${percentChange.toFixed(2)}%`,
      );
    }
  }

  /**
   * Stop all tracking
   */
  stopAll(): void {
    LOG.info("🛑 Stopping all P&L tracking...");
    this.trackedPositions.clear();
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
  }
}

export default new PnLTrackerService();
export { TrackedPosition };
