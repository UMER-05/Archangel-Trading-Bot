import { Router, Request, Response } from "express";
import {
  tokenMetadataCache,
  tokenPriceCache,
  tokenDiscoveryCache,
  quoteCache,
} from "../services/cache.service.js";

const router = Router();

/**
 * GET /api/cache/stats
 * Get cache statistics for all cache instances
 */
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const stats = {
      tokenMetadata: tokenMetadataCache.getStats(),
      tokenPrice: tokenPriceCache.getStats(),
      tokenDiscovery: tokenDiscoveryCache.getStats(),
      quote: quoteCache.getStats(),
      totalEntries:
        tokenMetadataCache.getStats().size +
        tokenPriceCache.getStats().size +
        tokenDiscoveryCache.getStats().size +
        quoteCache.getStats().size,
      totalMemory:
        tokenMetadataCache.getStats().memory +
        tokenPriceCache.getStats().memory +
        tokenDiscoveryCache.getStats().memory +
        quoteCache.getStats().memory,
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    console.error("Error fetching cache stats:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch cache stats",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * POST /api/cache/clear
 * Clear all caches
 */
router.post("/clear", async (req: Request, res: Response) => {
  try {
    const { cache } = req.body;

    if (cache === "all" || !cache) {
      tokenMetadataCache.clear();
      tokenPriceCache.clear();
      tokenDiscoveryCache.clear();
      quoteCache.clear();
      res.json({
        success: true,
        message: "All caches cleared",
      });
    } else if (cache === "metadata") {
      tokenMetadataCache.clear();
      res.json({
        success: true,
        message: "Token metadata cache cleared",
      });
    } else if (cache === "price") {
      tokenPriceCache.clear();
      res.json({
        success: true,
        message: "Token price cache cleared",
      });
    } else if (cache === "discovery") {
      tokenDiscoveryCache.clear();
      res.json({
        success: true,
        message: "Token discovery cache cleared",
      });
    } else if (cache === "quote") {
      quoteCache.clear();
      res.json({
        success: true,
        message: "Quote cache cleared",
      });
    } else {
      res.status(400).json({
        success: false,
        message:
          "Invalid cache name. Use: all, metadata, price, discovery, or quote",
      });
    }
  } catch (err) {
    console.error("Error clearing cache:", err);
    res.status(500).json({
      success: false,
      message: "Failed to clear cache",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

/**
 * DELETE /api/cache/:key
 * Delete a specific cache entry
 */
router.delete("/:key", async (req: Request, res: Response) => {
  try {
    const key = req.params.key;
    const cache = req.query.cache as string | undefined;

    if (!key) {
      res.status(400).json({
        success: false,
        message: "Cache key is required",
      });
      return;
    }

    let deleted = false;

    if (!cache || cache === "all") {
      // Try to delete from all caches
      deleted =
        tokenMetadataCache.delete(key) ||
        tokenPriceCache.delete(key) ||
        tokenDiscoveryCache.delete(key) ||
        quoteCache.delete(key);
    } else if (cache === "metadata") {
      deleted = tokenMetadataCache.delete(key);
    } else if (cache === "price") {
      deleted = tokenPriceCache.delete(key);
    } else if (cache === "discovery") {
      deleted = tokenDiscoveryCache.delete(key);
    } else if (cache === "quote") {
      deleted = quoteCache.delete(key);
    }

    if (deleted) {
      res.json({
        success: true,
        message: `Cache entry ${key} deleted`,
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Cache entry ${key} not found`,
      });
    }
  } catch (err) {
    console.error("Error deleting cache entry:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete cache entry",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

export default router;
