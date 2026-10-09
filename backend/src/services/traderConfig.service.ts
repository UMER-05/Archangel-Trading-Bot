// backend/src/services/traderConfig.service.ts
import { getLogger } from "../utils/logger.js";
import { MongoClient, Db } from "mongodb";
import { Server } from "socket.io";
import dotenv from "dotenv";
import { normalizeMaxOpenPositions } from "../utils/positionSizing.js";

// Defensive, same as db.service.ts — this module can be reached (via
// trade.route.ts's import, evaluated early in app.ts's route list) before
// index.ts's own dotenv.config() call has run, which would otherwise freeze
// MONGO_URI below as "" for the rest of the process.
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "archangel";

let dbInstance: Db | null = null;

async function getDb(): Promise<Db> {
  if (dbInstance) return dbInstance;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  dbInstance = client.db(MONGO_DB_NAME);
  return dbInstance;
}

const log = getLogger("TraderConfigService");

function boundedSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value))
    ? value
    : fallback;
}

export interface TraderConfig {
  walletAddress: string;
  globalSettings: {
    minMarketCapSol?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    // Only buy a token once its pool is at least this old in seconds.
    minSecondsSinceLaunch?: number;
    autoTradeEnabled?: boolean;
    // How many positions the bot may hold at once. The trading wallet's
    // balance is split across them (balance / free slots — see
    // utils/positionSizing.ts), so this is a COUNT, not a SOL amount. Unset
    // falls back to DEFAULT_MAX_OPEN_POSITIONS. (Replaces the old
    // maxTradeAmountSol; a stored copy of that field is simply ignored.)
    maxOpenPositions?: number;
    // Trading budget: the most SOL the bot may have at work at once. Anything
    // the wallet holds beyond it (profits, later deposits) is protected — the
    // bot never trades it. null/undefined = no budget (it may use the whole
    // wallet balance). See utils/positionSizing.ts.
    tradingBudgetSol?: number | null;
    // When the budget was last set or changed (ms since epoch). Set by the
    // server, never trusted from the client: only losses realized after this
    // moment lower the budget's capital. See routes/traderConfig.route.ts.
    tradingBudgetSetAt?: number;
    // Lifetime cap on how many trades the bot may take for this wallet —
    // null/undefined means unlimited. Enforced in
    // multiUserExecution.service.ts's getEligibleWallets() against the live
    // count from dbService.getTotalTradesCount(), not a stored counter.
    // Once reached, auto-trading stops for this wallet until the trader
    // raises the number (there's no separate "reset" — the count reflects
    // real trade history). null explicitly clears a previously-set cap.
    maxTotalTrades?: number | null;
    /** Exact SOL amount for each auto-buy; unset means split balance across free slots. */
    fixedTradeAmountSol?: number | null;
    /** Jupiter slippage tolerance in basis points. */
    slippageBps?: number;
    /** Jupiter prioritization fee in SOL. */
    priorityFeeSol?: number;
    /** Per-wallet daily-loss circuit breaker. */
    maxDailyLossPct?: number;
    /** Per-wallet maximum trade size as a percent of portfolio equity. */
    maxRiskPerTradePct?: number;
  };
  tokenSpecificSettings: {
    [mint: string]: {
      minMarketCapSol?: number;
      takeProfitPct?: number;
      stopLossPct?: number;
      entryPriceSol?: number;
      triggerMarketCapSol?: number; // MC at which trade should trigger
      autoTrade?: boolean;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get trader configuration
 */
export async function getTraderConfig(
  walletAddress: string,
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();
    const config = await db
      .collection<TraderConfig>("traderConfigs")
      .findOne({ walletAddress });

    return config;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to get trader config");
    return null;
  }
}

/**
 * A specific wallet's own minimum pool age in seconds. Unconfigured (or an
 * invalid value) defaults to 0 — no minimum wait — rather than disabling
 * auto-buy for the wallet entirely. The client's stated requirement is
 * maximum coverage of newly launched tokens with only a market-cap floor as
 * a real gate; a wallet that's never explicitly touched this setting should
 * default to "trade immediately," not "never trade, silently, forever."
 */
export async function getEffectiveLaunchWindowSeconds(
  walletAddress: string,
): Promise<number> {
  const config = await getTraderConfig(walletAddress);
  const g = config?.globalSettings;
  if (
    typeof g?.minSecondsSinceLaunch !== "number" ||
    !Number.isFinite(g.minSecondsSinceLaunch) ||
    g.minSecondsSinceLaunch < 0
  ) {
    return 0;
  }
  return g.minSecondsSinceLaunch;
}

/**
 * Create or update trader global settings
 */
export async function updateGlobalSettings(
  walletAddress: string,
  settings: TraderConfig["globalSettings"],
  io?: Server,
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();

    const result = await db
      .collection<TraderConfig>("traderConfigs")
      .findOneAndUpdate(
        { walletAddress },
        {
          $set: {
            globalSettings: settings,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            walletAddress,
            tokenSpecificSettings: {},
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after" },
      );

    log.info({ walletAddress, settings }, "Updated global trader settings");

    // Emit to frontend
    if (io) {
      io.to(walletAddress).emit("traderConfig:updated", result);
    }

    return result;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to update global settings");
    return null;
  }
}

/**
 * Flip just autoTradeEnabled without touching any other saved setting —
 * updateGlobalSettings() above replaces the entire globalSettings object, so
 * using it here would silently wipe this wallet's market-cap/token-age/
 * launch-window/etc. settings. Used by the "Stop Auto Trade" flow, which
 * must disable future auto-buys without clobbering everything else the
 * wallet has configured.
 */
export async function setAutoTradeEnabled(
  walletAddress: string,
  enabled: boolean,
  io?: Server,
): Promise<void> {
  const db = await getDb();
  const result = await db
    .collection<TraderConfig>("traderConfigs")
    .findOneAndUpdate(
      { walletAddress },
      {
        $set: {
          "globalSettings.autoTradeEnabled": enabled,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          walletAddress,
          tokenSpecificSettings: {},
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  log.info({ walletAddress, enabled }, "Set autoTradeEnabled");
  if (io) {
    io.to(walletAddress).emit("traderConfig:updated", result);
  }
}

/**
 * Set token-specific trading configuration
 */
export async function setTokenConfig(
  walletAddress: string,
  mint: string,
  config: TraderConfig["tokenSpecificSettings"][string],
  io?: Server,
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();

    const result = await db
      .collection<TraderConfig>("traderConfigs")
      .findOneAndUpdate(
        { walletAddress },
        {
          $set: {
            [`tokenSpecificSettings.${mint}`]: config,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            walletAddress,
            globalSettings: {},
            tokenSpecificSettings: {},
            createdAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after" },
      );

    log.info(
      { walletAddress, mint, config },
      "Set token-specific configuration",
    );

    // Emit to frontend
    if (io) {
      io.to(walletAddress).emit("traderConfig:updated", result);
    }

    return result;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to set token config");
    return null;
  }
}

/**
 * Remove token-specific configuration
 */
export async function removeTokenConfig(
  walletAddress: string,
  mint: string,
  io?: Server,
): Promise<TraderConfig | null> {
  try {
    const db = await getDb();

    const result = await db
      .collection<TraderConfig>("traderConfigs")
      .findOneAndUpdate(
        { walletAddress },
        {
          $unset: {
            [`tokenSpecificSettings.${mint}`]: "",
          },
          $set: {
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" },
      );

    log.info({ walletAddress, mint }, "Removed token-specific configuration");

    // Emit to frontend
    if (io) {
      io.to(walletAddress).emit("traderConfig:updated", result);
    }

    return result;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to remove token config");
    return null;
  }
}

/**
 * How many positions this wallet's bot may hold at once (its "Max Open
 * Positions" setting, or the default if it never chose one).
 */
export async function getMaxOpenPositions(
  walletAddress: string,
): Promise<number> {
  const config = await getTraderConfig(walletAddress);
  return normalizeMaxOpenPositions(config?.globalSettings?.maxOpenPositions);
}

/**
 * Get effective configuration for a specific token
 * (token-specific settings override global settings)
 */
export async function getEffectiveConfig(
  walletAddress: string,
  mint: string,
): Promise<{
  minMarketCapSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxOpenPositions: number;
  fixedTradeAmountSol: number | null;
  slippageBps: number;
  priorityFeeSol: number;
  maxDailyLossPct: number;
  maxRiskPerTradePct: number;
  triggerMarketCapSol?: number;
  autoTrade: boolean;
}> {
  const config = await getTraderConfig(walletAddress);
  const environmentSlippageBps = boundedSetting(
    Math.round(Number(process.env.AUTO_BUY_SLIPPAGE_PCT ?? 10) * 100),
    1000,
    10,
    10_000,
    true,
  );
  const environmentPriorityFeeSol = boundedSetting(
    Number(process.env.JUPITER_PRIORITY_FEE ?? 0.00003),
    0.00003,
    0,
    0.01,
  );
  const environmentMaxDailyLossPct = boundedSetting(
    Number(process.env.MAX_DAILY_LOSS_PCT ?? 6),
    6,
    0.1,
    100,
  );
  const environmentMaxRiskPerTradePct = boundedSetting(
    Number(process.env.MAX_RISK_PER_TRADE_PCT ?? 2),
    2,
    0.1,
    100,
  );

  // Default values from environment
  const defaults = {
    minMarketCapSol: Number(process.env.MIN_MARKETCAP_SOL ?? 3),
    takeProfitPct: Number(process.env.TP_PCT ?? 0.1),
    maxOpenPositions: normalizeMaxOpenPositions(undefined),
    fixedTradeAmountSol: null,
    slippageBps: environmentSlippageBps,
    priorityFeeSol: environmentPriorityFeeSol,
    maxDailyLossPct: environmentMaxDailyLossPct,
    maxRiskPerTradePct: environmentMaxRiskPerTradePct,
    // Must match monitor.service.ts's DEFAULT_SL_PCT fallback (0.3) — that
    // 2% figure was the pre-fix default that caused a self-inflicted
    // stop-loss bug (see monitor.service.ts). Both read SL_PCT so they agree
    // whenever it's set, but diverged silently if it were ever unset.
    stopLossPct: Number(process.env.SL_PCT ?? 0.3),
    autoTrade: false,
  };

  if (!config) {
    return defaults;
  }

  // Get token-specific settings
  const tokenSettings = config.tokenSpecificSettings[mint] || {};

  // Merge: defaults < global < token-specific
  const result: {
    minMarketCapSol: number;
    takeProfitPct: number;
    stopLossPct: number;
    maxOpenPositions: number;
    fixedTradeAmountSol: number | null;
    slippageBps: number;
    priorityFeeSol: number;
    maxDailyLossPct: number;
    maxRiskPerTradePct: number;
    triggerMarketCapSol?: number;
    autoTrade: boolean;
  } = {
    minMarketCapSol:
      tokenSettings.minMarketCapSol ??
      config.globalSettings.minMarketCapSol ??
      defaults.minMarketCapSol,
    takeProfitPct:
      tokenSettings.takeProfitPct ??
      config.globalSettings.takeProfitPct ??
      defaults.takeProfitPct,
    stopLossPct:
      tokenSettings.stopLossPct ??
      config.globalSettings.stopLossPct ??
      defaults.stopLossPct,
    maxOpenPositions: normalizeMaxOpenPositions(
      config.globalSettings.maxOpenPositions,
    ),
    fixedTradeAmountSol:
      config.globalSettings.fixedTradeAmountSol != null &&
      Number.isFinite(config.globalSettings.fixedTradeAmountSol) &&
      config.globalSettings.fixedTradeAmountSol > 0
        ? config.globalSettings.fixedTradeAmountSol
        : null,
    slippageBps:
      boundedSetting(
        config.globalSettings.slippageBps,
        defaults.slippageBps,
        10,
        10_000,
        true,
      ),
    priorityFeeSol:
      boundedSetting(
        config.globalSettings.priorityFeeSol,
        defaults.priorityFeeSol,
        0,
        0.01,
      ),
    maxDailyLossPct:
      boundedSetting(
        config.globalSettings.maxDailyLossPct,
        defaults.maxDailyLossPct,
        0.1,
        100,
      ),
    maxRiskPerTradePct:
      boundedSetting(
        config.globalSettings.maxRiskPerTradePct,
        defaults.maxRiskPerTradePct,
        0.1,
        100,
      ),
    autoTrade:
      tokenSettings.autoTrade ??
      config.globalSettings.autoTradeEnabled ??
      defaults.autoTrade,
  };

  if (tokenSettings.triggerMarketCapSol !== undefined) {
    result.triggerMarketCapSol = tokenSettings.triggerMarketCapSol;
  }

  return result;
}

/**
 * Check if a trade should be triggered based on current market cap
 */
export async function shouldTriggerTrade(
  walletAddress: string,
  mint: string,
  currentMarketCapSol: number,
): Promise<boolean> {
  const effectiveConfig = await getEffectiveConfig(walletAddress, mint);

  // If trigger MC is set, check if current MC meets it.
  if (effectiveConfig.triggerMarketCapSol) {
    return currentMarketCapSol >= effectiveConfig.triggerMarketCapSol;
  }

  return currentMarketCapSol >= effectiveConfig.minMarketCapSol;
}

/**
 * Get all traders with token-specific configurations
 */
export async function getTradersWithTokenConfig(
  mint: string,
): Promise<TraderConfig[]> {
  try {
    const db = await getDb();
    const configs = await db
      .collection<TraderConfig>("traderConfigs")
      .find({
        [`tokenSpecificSettings.${mint}`]: { $exists: true },
      })
      .toArray();

    return configs;
  } catch (err: any) {
    log.error({ err: err.message }, "Failed to get traders with token config");
    return [];
  }
}
