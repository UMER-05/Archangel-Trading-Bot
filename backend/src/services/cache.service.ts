// backend/src/services/cache.service.ts
import { getLogger } from "../utils/logger.js";

const log = getLogger("cache.service");

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class CacheService {
  private cache: Map<string, CacheEntry<any>>;
  private defaultTTL: number;

  constructor(defaultTTL: number = 60000) {
    // Default 60 seconds
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
    this.startCleanupInterval();
  }

  /**
   * Set a value in cache with optional TTL
   */
  set<T>(key: string, value: T, ttl?: number): void {
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    this.cache.set(key, { data: value, expiresAt });
    log.debug(`Cache SET: ${key} (TTL: ${ttl || this.defaultTTL}ms)`);
  }

  /**
   * Get a value from cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      log.debug(`Cache MISS: ${key}`);
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      log.debug(`Cache EXPIRED: ${key}`);
      return null;
    }

    log.debug(`Cache HIT: ${key}`);
    return entry.data as T;
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      log.debug(`Cache DELETE: ${key}`);
    }
    return deleted;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    log.info(`Cache cleared: ${size} entries removed`);
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    keys: string[];
    memory: number;
  } {
    const keys = Array.from(this.cache.keys());
    const memory = keys.reduce((acc, key) => {
      const entry = this.cache.get(key);
      return acc + (entry ? JSON.stringify(entry.data).length : 0);
    }, 0);

    return {
      size: this.cache.size,
      keys,
      memory,
    };
  }

  /**
   * Get or set pattern - fetch from cache or execute function and cache result
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    log.debug(`Cache FETCH: ${key}`);
    const data = await fetchFn();
    this.set(key, data, ttl);
    return data;
  }

  /**
   * Clean up expired entries periodically
   */
  private startCleanupInterval(): void {
    const timer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.cache.entries()) {
        if (now > entry.expiresAt) {
          this.cache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        log.debug(`Cache cleanup: ${cleaned} expired entries removed`);
      }
    }, 60000); // Run every minute
    // These 4 caches are instantiated at module load, unconditionally, just
    // by importing this file (transitively via cache.route.ts) — a bare
    // setInterval keeps that reference alive forever, which is irrelevant in
    // production (the HTTP server keeps the process alive anyway) but is
    // exactly the kind of stray timer that makes test runners hang waiting
    // for the process to exit on its own after tests finish.
    timer.unref?.();
  }

  /**
   * Invalidate cache entries by pattern
   */
  invalidatePattern(pattern: string | RegExp): number {
    let count = 0;
    const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }

    if (count > 0) {
      log.info(
        `Invalidated ${count} cache entries matching pattern: ${pattern}`,
      );
    }

    return count;
  }
}

// Create singleton instances with different TTLs for different use cases
// TTLs can be configured via environment variables
const METADATA_TTL = Number(process.env.CACHE_TOKEN_METADATA_TTL) || 300000; // Default 5 minutes
const PRICE_TTL = Number(process.env.CACHE_TOKEN_PRICE_TTL) || 10000; // Default 10 seconds
const DISCOVERY_TTL = Number(process.env.CACHE_TOKEN_DISCOVERY_TTL) || 30000; // Default 30 seconds
const QUOTE_TTL = Number(process.env.CACHE_QUOTE_TTL) || 5000; // Default 5 seconds
// Used by resolveLiquidityUsd (jupiter.service.ts) — a risk-check heuristic
// (e.g. emergencyExit.service.ts's detectLargeSell, polled every monitor
// tick for every open position, for that position's entire lifetime) doesn't
// need millisecond-fresh liquidity, and without this every single tick was a
// guaranteed live Jupiter quote call, scaling linearly with concurrent open
// positions.
const LIQUIDITY_TTL = Number(process.env.CACHE_LIQUIDITY_TTL) || 15000; // Default 15 seconds

export const tokenMetadataCache = new CacheService(METADATA_TTL);
export const tokenPriceCache = new CacheService(PRICE_TTL);
export const tokenDiscoveryCache = new CacheService(DISCOVERY_TTL);
export const quoteCache = new CacheService(QUOTE_TTL);
export const liquidityCache = new CacheService(LIQUIDITY_TTL);

log.info(
  `Cache initialized - Metadata: ${METADATA_TTL}ms, Price: ${PRICE_TTL}ms, Discovery: ${DISCOVERY_TTL}ms, Quote: ${QUOTE_TTL}ms, Liquidity: ${LIQUIDITY_TTL}ms`,
);

export default {
  tokenMetadataCache,
  tokenPriceCache,
  tokenDiscoveryCache,
  quoteCache,
  liquidityCache,
};
