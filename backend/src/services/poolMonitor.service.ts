import { getLogger } from "../utils/logger.js";
import { getJupiterQuote } from "./jupiter.service.js";
import { EventEmitter } from "events";

const log = getLogger("poolMonitor");

interface PoolMonitorRequest {
  tokenMint: string;
  inputMint: string;
  outputMint: string;
  wallet: string;
  timestamp: number;
  retryCount: number;
}

class PoolMonitorService extends EventEmitter {
  private monitoredTokens: Map<string, PoolMonitorRequest> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly MAX_RETRIES = 20; // 20 attempts over ~10 minutes
  private readonly CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

  constructor() {
    super();
    this.startMonitoring();
  }

  /**
   * Add a token to monitor for Jupiter route availability
   */
  addToken(
    tokenMint: string,
    inputMint: string,
    outputMint: string,
    wallet: string
  ): void {
    const key = `${tokenMint}-${wallet}`;

    if (this.monitoredTokens.has(key)) {
      log.info(
        `Token ${tokenMint.slice(
          0,
          8
        )}... already being monitored for ${wallet.slice(0, 8)}...`
      );
      return;
    }

    this.monitoredTokens.set(key, {
      tokenMint,
      inputMint,
      outputMint,
      wallet,
      timestamp: Date.now(),
      retryCount: 0,
    });

    log.info(
      `Started monitoring token ${tokenMint.slice(
        0,
        8
      )}... for Jupiter route (wallet: ${wallet.slice(0, 8)}...)`
    );

    // Trigger immediate check
    this.checkToken(key);
  }

  /**
   * Remove a token from monitoring
   */
  removeToken(tokenMint: string, wallet: string): void {
    const key = `${tokenMint}-${wallet}`;
    if (this.monitoredTokens.delete(key)) {
      log.info(`Stopped monitoring token ${tokenMint.slice(0, 8)}...`);
    }
  }

  /**
   * Get all monitored tokens for a wallet
   */
  getMonitoredTokensForWallet(wallet: string): string[] {
    return Array.from(this.monitoredTokens.values())
      .filter((req) => req.wallet === wallet)
      .map((req) => req.tokenMint);
  }

  /**
   * Start the monitoring interval
   */
  private startMonitoring(): void {
    if (this.checkInterval) {
      return;
    }

    log.info("Starting pool monitor service...");

    this.checkInterval = setInterval(() => {
      this.checkAllTokens();
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop the monitoring interval
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      log.info("Pool monitor service stopped");
    }
  }

  /**
   * Check all monitored tokens
   */
  private async checkAllTokens(): Promise<void> {
    const tokens = Array.from(this.monitoredTokens.keys());

    if (tokens.length === 0) {
      return;
    }

    log.debug(
      `Checking ${tokens.length} monitored tokens for Jupiter routes...`
    );

    for (const key of tokens) {
      await this.checkToken(key);
    }
  }

  /**
   * Check a specific token for Jupiter route availability
   */
  private async checkToken(key: string): Promise<void> {
    const request = this.monitoredTokens.get(key);

    if (!request) {
      return;
    }

    const { tokenMint, inputMint, outputMint, wallet, retryCount } = request;

    try {
      // Try to get a Jupiter quote
      const quote = await getJupiterQuote(
        inputMint,
        outputMint,
        100000000, // 0.1 SOL test amount
        100 // 1% slippage in bps
      );

      if (quote) {
        // Route found! Emit event and remove from monitoring
        log.info(
          `✓ Jupiter route now available for token ${tokenMint.slice(0, 8)}...!`
        );

        this.emit("poolAvailable", {
          tokenMint,
          wallet,
          inputMint,
          outputMint,
          quote,
        });

        this.monitoredTokens.delete(key);
      } else {
        // Pool not found yet, increment retry count
        request.retryCount++;

        if (request.retryCount >= this.MAX_RETRIES) {
          log.warn(
            `Token ${tokenMint.slice(0, 8)}... exceeded max retries (${
              this.MAX_RETRIES
            }), stopping monitoring`
          );

          this.emit("monitoringTimeout", {
            tokenMint,
            wallet,
            retryCount: request.retryCount,
          });

          this.monitoredTokens.delete(key);
        } else {
          log.debug(
            `Token ${tokenMint.slice(
              0,
              8
            )}... not yet available on Jupiter (attempt ${request.retryCount}/${
              this.MAX_RETRIES
            })`
          );
        }
      }
    } catch (error: any) {
      log.error(
        `Error checking token ${tokenMint.slice(0, 8)}...: ${error.message}`
      );
      request.retryCount++;

      if (request.retryCount >= this.MAX_RETRIES) {
        this.monitoredTokens.delete(key);
      }
    }
  }

  /**
   * Get monitoring status
   */
  getStatus(): {
    monitoredCount: number;
    tokens: Array<{
      tokenMint: string;
      wallet: string;
      retryCount: number;
      elapsedMinutes: number;
    }>;
  } {
    const now = Date.now();
    const tokens = Array.from(this.monitoredTokens.values()).map((req) => ({
      tokenMint: req.tokenMint,
      wallet: req.wallet,
      retryCount: req.retryCount,
      elapsedMinutes: Math.floor((now - req.timestamp) / 60000),
    }));

    return {
      monitoredCount: this.monitoredTokens.size,
      tokens,
    };
  }
}

// Singleton instance
export const poolMonitor = new PoolMonitorService();

export default poolMonitor;
