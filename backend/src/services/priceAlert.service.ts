// backend/src/services/priceAlert.service.ts
import { Server } from "socket.io";
import { getLogger } from "../utils/logger.js";
import dbService from "./db.service.js";
import { fetchPricesForMints } from "./price.service.js";

const log = getLogger("priceAlert");

let alertCheckInterval: NodeJS.Timeout | null = null;

/**
 * Start monitoring price alerts
 */
export function startPriceAlertMonitor(
  io: Server,
  opts?: { intervalMs?: number },
) {
  const intervalMs = opts?.intervalMs ?? 60000; // Check every minute by default

  log.info(`Starting price alert monitor (interval: ${intervalMs}ms)`);

  const checkAlerts = async () => {
    try {
      // Get all watchlist tokens with price alerts
      const watchlist = await dbService.getWatchlist();
      const tokensWithAlerts = watchlist.filter(
        (token) =>
          token.priceAlert &&
          token.priceAlert.targetPrice &&
          !token.priceAlert.triggered,
      );

      if (tokensWithAlerts.length === 0) {
        return;
      }

      log.debug(`Checking ${tokensWithAlerts.length} price alerts`);

      // Fetch current prices for all tokens with alerts
      const mints = tokensWithAlerts.map((t) => t.mint);
      const prices = await fetchPricesForMints(mints);

      // Check each alert
      for (const token of tokensWithAlerts) {
        const priceData = prices[token.mint];
        if (!priceData || !priceData.price) {
          continue;
        }

        const currentPrice = priceData.price;
        const alert = token.priceAlert!;
        const targetPrice = alert.targetPrice;

        let triggered = false;

        if (alert.condition === "above" && currentPrice >= targetPrice) {
          triggered = true;
        } else if (alert.condition === "below" && currentPrice <= targetPrice) {
          triggered = true;
        }

        if (triggered) {
          log.info(
            `Price alert triggered: ${token.symbol} ${alert.condition} $${targetPrice} (current: $${currentPrice})`,
          );

          // Mark alert as triggered in database
          await dbService.updateWatchlistAlert(
            token.mint,
            { ...alert, triggered: true },
            token.userId,
          );

          // Emit alert to the wallet that set it (legacy shared entries
          // without an owner still go to everyone, as before).
          const alertPayload = {
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            userId: token.userId,
            currentPrice,
            targetPrice,
            condition: alert.condition,
            timestamp: new Date().toISOString(),
          };
          if (token.userId)
            io.to(token.userId).emit("priceAlert:triggered", alertPayload);
          else io.emit("priceAlert:triggered", alertPayload);

          log.info(`Emitted priceAlert:triggered for ${token.symbol}`);
        }
      }
    } catch (err: any) {
      log.error(
        { err: err?.message ?? String(err) },
        "Error checking price alerts",
      );
    }
  };

  // Run initial check
  checkAlerts();

  // Set up interval
  alertCheckInterval = setInterval(checkAlerts, intervalMs);
}

/**
 * Stop the price alert monitor
 */
export function stopPriceAlertMonitor() {
  if (alertCheckInterval) {
    clearInterval(alertCheckInterval);
    alertCheckInterval = null;
    log.info("Price alert monitor stopped");
  }
}
