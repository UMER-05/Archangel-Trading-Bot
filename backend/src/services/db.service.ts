// backend/src/services/db.service.ts

import { MongoClient, Db, Collection } from "mongodb";
import { getLogger } from "../utils/logger.js";
import crypto from "crypto";
import dotenv from "dotenv";
import {
  POSITION_DUST_THRESHOLD_SOL,
  deployedSolOf,
  isOpenPosition,
  realizedLossSolSince,
} from "../utils/positionState.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "archangel";

const log = getLogger("db.service");

// The bot's own operating wallet — every operator-signed auto-trade uses
// this key (see backend/.env's ADMIN_WALLET_SECRET). Its trades are its own
// private activity too, exactly like any custodial user's — see
// viewerWalletFilter() below. Exported so the few call sites that broadcast
// to sockets with no specific connected wallet (pnlBroadcaster.service.ts,
// socket.route.ts) can explicitly show the operator's own numbers as that
// "no wallet connected" public view, instead of every user's data blended
// together.
export const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

/**
 * Builds the trade-visibility filter for a given viewer. When viewerWallet
 * is omitted (internal engine callers like riskManagement.service.ts and
 * monitor.service.ts, which must manage the bot's REAL, complete position
 * set across every wallet regardless of who's looking), this returns {} —
 * no filtering. When a viewerWallet IS provided (a dashboard route acting on
 * behalf of one specific connected wallet), visibility is restricted to
 * strictly that wallet's own trades — including when that wallet is the
 * operator's own. No wallet's activity is ever mixed into another's view.
 */
function viewerWalletFilter(viewerWallet?: string): Record<string, any> {
  if (!viewerWallet) return {};
  return { wallet: viewerWallet };
}

/* ---------------------------------------
   TYPE DEFINITIONS
---------------------------------------- */
export type TradeRecord = {
  id: string;
  type: "buy" | "sell";
  token: string;
  inputMint?: string;
  outputMint?: string;
  amountLamports: number;
  amountSol: number;
  price?: number;
  pnl?: number; // percent decimal ex: 0.02 means +2%
  pnlSol?: number; // absolute SOL PnL
  wallet?: string;
  simulated?: boolean;
  signature?: string | null;
  timestamp: Date;
  route?: "jupiter" | "raydium-cpmm" | "raydium-amm-v4" | "raydium-clmm";
  // Which wallet actually holds/signs for these tokens on-chain — "self"
  // means the connected wallet itself (a manual buy/sell, signed directly by
  // the user's own Phantom/Solflare), "custodial" means the server-managed
  // hot wallet (an auto-trade, signed with the encrypted custodial keypair).
  // Both are recorded under the same `wallet` (owner) field, so without this
  // there's no way to tell which keypair a sell for a given position would
  // even need — see getPositions()'s compound grouping below.
  custody?: "self" | "custodial";
};

export type StatsDoc = {
  _id?: string;
  portfolioValue: number;
  totalProfitSol: number;
  totalProfitPercent: number;
  openTrades: number;
  tradeVolumeSol: number;
  winRate: number;
  lastUpdated: Date;
};

// Mirrors frontend/hooks/useConfig.ts's TradingConfig data fields exactly —
// field names must match 1:1 so loadConfigFromAPI() can apply the response
// straight into the zustand store with no translation layer (the previous
// stub returned autoMode/manualAmountSol, which don't match the store's
// autoTrade/amount fields and silently no-op'd).
export type UserSettings = {
  wallet: string;
  autoTrade?: boolean;
  selectedToken?: string;
  updatedAt: Date;
};

export type PortfolioPnL = {
  totalInvestedSol: number;
  totalReturnedSol: number;
  unrealizedPnlSol: number;
  realizedPnlSol: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  winningTrades: number;
  losingTrades: number;
  totalTrades: number;
  winRate: number;
  averageWinSol: number;
  averageLossSol: number;
  largestWinSol: number;
  largestLossSol: number;
  openPositionsValue: number;
  closedPositionsValue: number;
  roi: number; // Return on Investment %
};

export type TokenPnL = {
  token: string;
  symbol?: string;
  totalBought: number; // SOL spent
  totalSold: number; // SOL received
  remainingTokens: number;
  averageBuyPrice: number;
  currentValue?: number;
  pnlSol: number;
  pnlPercent: number;
  trades: number;
  status: "open" | "closed";
};

export type WatchlistToken = {
  _id?: string;
  mint: string;
  symbol?: string;
  name?: string;
  addedAt: Date;
  userId?: string; // For multi-user support
  priceAlert?: {
    targetPrice: number; // Alert when price reaches this
    condition: "above" | "below";
    triggered?: boolean;
  };
  notes?: string;
};

// Token lifecycle states for new trade rules (Jupiter-only: no separate
// bonding-curve/graduation stages — a token is discovered, confirmed tradable, or acted on)
export type TokenLifecycleState =
  | "DISCOVERED"
  | "TRADABLE"
  | "SECURITY_VERIFIED"
  | "BOUGHT"
  | "PARTIALLY_SOLD"
  | "FULLY_EXITED"
  | "BLACKLISTED";

export type TokenState = {
  _id?: string;
  mint: string;
  symbol?: string;
  name?: string;
  state: TokenLifecycleState;
  // "quicknode" = discovered via the QuickNode pool-creation webhook (the
  // current single discovery path). "jupiter" is kept for rows written by
  // the old Jupiter-polling discovery loops prior to this pipeline
  // consolidation; "other" remains a catch-all.
  source: "quicknode" | "solami" | "blur" | "jupiter" | "other";

  marketCapUSD?: number;
  launchMarketCapUSD?: number;
  launchMarketCapSOL?: number;
  buyVolume?: number;
  sellVolume?: number;

  // Jupiter tradability metrics
  jupiterTradable?: boolean;
  // Set once, after this mint passes every Phase 4 ArchAngel filter (see
  // candidatePipeline.service.ts) — exposed via GET /api/tokens/active
  // (all recent candidates) and GET /api/tokens/approved-candidates (only
  // this flag true) in tokens.route.ts. Left unset (falsy) for anything
  // that never reached or never passed Phase 4 — callers compare with
  // `=== true`, so undefined and false are equivalent here.
  autoBuyEligible?: boolean;
  liquidityUSD?: number;
  liquiditySOL?: number;
  launchLiquidityUSD?: number;
  launchLiquiditySOL?: number;
  poolCreatedAt?: Date;
  launchSnapshotAt?: Date;
  poolAddress?: string;
  // The DEX string as reported by discovery (e.g. "raydium-cpmm") — see
  // tokenExtraction.service.ts's CandidateMint. Persisted so anything that
  // needs it after discovery (the sell-side execution router, in
  // particular — it has to know a position's pool type to decide native-
  // vs-Jupiter eligibility) doesn't need to re-derive or guess it later.
  dex?: string;
  creatorAddress?: string; // token dev/creator wallet, used by emergencyExit's creator-sell trigger

  // Security checks
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  creatorHoldings?: number;
  top3WalletsCombined?: number;
  lpRemoved?: boolean;

  // Timestamps
  detectedAt: Date;
  confirmedTradableAt?: Date;
  boughtAt?: Date;
  exitedAt?: Date;
  blacklistedAt?: Date;

  // Blacklist reason
  blacklistReason?: string;

  updatedAt: Date;
};

// --- Old Token Analytics Extensions ---
export type TokenPriceHistory = {
  timestamp: Date;
  price: number;
  liquidityUSD?: number;
  volumeUSD?: number;
};

export type TokenAnalytics = {
  priceChange1h?: number;
  priceChange24h?: number;
  priceChange7d?: number;
  volume1h?: number;
  volume24h?: number;
  volume7d?: number;
  liquidityHistory?: TokenPriceHistory[];
};

export type TokenSignal = {
  type: "momentum" | "mean-reversion" | "breakout" | "custom";
  description: string;
  triggeredAt: Date;
  params?: Record<string, any>;
};

// Extend TokenState for old token analytics
export type OldTokenState = TokenState & {
  priceHistory?: TokenPriceHistory[];
  analytics?: TokenAnalytics;
  signals?: TokenSignal[];
  isOldToken?: boolean; // Flag for old token universe
};

/* ---------------------------------------
   CONNECTION
---------------------------------------- */
export type PositionMetadata = {
  token: string;
  // Multiple wallets can independently hold a position in the same token —
  // tranche/tier/trailing-stop progress must be tracked per (token, wallet)
  // pair, not per token alone, or two different users' positions in the
  // same coin would silently share (and corrupt) one metadata record.
  wallet: string;
  highestPnlPct?: number;
  trailingActivated?: boolean;
  soldAt40?: boolean;
  soldAt80?: boolean;
  soldAt150?: boolean;
  remainingPct?: number;
  firstTrancheEntry?: number;
  secondTrancheEntry?: number;
  tpPct?: number;
  slPct?: number;
  // Consecutive sell-attempt failures for this position (any exit path —
  // emergency, tiered, or final TP/SL) and when the most recent attempt
  // happened. Lets monitor.service.ts back off and stop re-notifying every
  // 5-second tick for a token with genuinely no Jupiter route left (a dead
  // pool), rather than retrying — and alerting — forever. Reset to 0 on any
  // successful sell.
  sellFailureCount?: number;
  lastSellAttemptAt?: Date;
  updatedAt: Date;
};

export type DiscoveryClaim = {
  mint: string;
  ownerId: string;
  status: "claimed" | "completed";
  claimedAt: Date;
  leaseUntil: Date;
  completedAt?: Date;
};

// Mirrors DiscoveryClaim's shape exactly, but keyed by (token, wallet) —
// a position, unlike a discovery candidate, belongs to one specific wallet.
// Exists so two overlapping monitor.service.ts ticks (or two process
// instances) can never both decide to sell the same wallet's position at
// once — see positionExitCoordinator.service.ts, which wraps this the same
// way discoveryCoordinator.service.ts wraps DiscoveryClaim.
export type PositionExitClaim = {
  token: string;
  wallet: string;
  ownerId: string;
  status: "claimed" | "completed";
  claimedAt: Date;
  leaseUntil: Date;
  completedAt?: Date;
};

let discoveryClaimsCol: Collection<DiscoveryClaim> | null = null;
let positionExitClaimsCol: Collection<PositionExitClaim> | null = null;
let client: MongoClient | null = null;
let db: Db | null = null;
let tradesCol: Collection<TradeRecord> | null = null;
let statsCol: Collection<StatsDoc> | null = null;
let watchlistCol: Collection<WatchlistToken> | null = null;
let positionMetadataCol: Collection<PositionMetadata> | null = null;
let tokenStateCol: Collection<TokenState> | null = null;
let userSettingsCol: Collection<UserSettings> | null = null;

export async function connect() {
  if (client && db) return db;
  if (!MONGO_URI) throw new Error("MONGO_URI missing");
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB_NAME);
  tradesCol = db.collection<TradeRecord>("trades");
  statsCol = db.collection<StatsDoc>("stats");
  watchlistCol = db.collection<WatchlistToken>("watchlist");
  positionMetadataCol = db.collection<PositionMetadata>("positionMetadata");
  tokenStateCol = db.collection<TokenState>("tokenStates");
  userSettingsCol = db.collection<UserSettings>("userSettings");
  discoveryClaimsCol = db.collection<DiscoveryClaim>("discoveryClaims");
  positionExitClaimsCol =
    db.collection<PositionExitClaim>("positionExitClaims");
  // New collection for old token analytics (optional, or store in tokenStates)
  // const oldTokenStateCol = db.collection<OldTokenState>("oldTokenStates");
  await tradesCol.createIndex({ timestamp: -1 });
  await watchlistCol.createIndex({ mint: 1 });
  await watchlistCol.createIndex({ userId: 1 });
  // Was a unique index on token alone, from when only one wallet ever held
  // positions — that would now reject a second wallet's metadata for a
  // token the first wallet is also holding. Drop it (no-op if it never
  // existed, e.g. a fresh DB) and replace with the real compound identity.
  try {
    await positionMetadataCol.dropIndex("token_1");
  } catch (err: any) {
    // Either the index was never created (IndexNotFound) or the collection
    // itself doesn't exist yet — e.g. a brand-new DB, as in the test suite's
    // in-memory MongoDB (surfaces as "ns not found"/NamespaceNotFound rather
    // than IndexNotFound). Both are fine: there's nothing to drop either way.
    const benign =
      err?.codeName === "IndexNotFound" ||
      err?.codeName === "NamespaceNotFound" ||
      err?.code === 26 ||
      err?.code === 27 ||
      /ns not found/i.test(err?.message ?? "");
    if (!benign) throw err;
  }
  await positionMetadataCol.createIndex(
    { token: 1, wallet: 1 },
    { unique: true },
  );
  await tokenStateCol.createIndex({ mint: 1 }, { unique: true });
  await tokenStateCol.createIndex({ state: 1 });
  await tokenStateCol.createIndex({ updatedAt: -1 });
  await userSettingsCol.createIndex({ wallet: 1 }, { unique: true });
  await discoveryClaimsCol.createIndex({ mint: 1 }, { unique: true });
  await discoveryClaimsCol.createIndex(
    { completedAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60 },
  );
  await positionExitClaimsCol.createIndex(
    { token: 1, wallet: 1 },
    { unique: true },
  );
  await positionExitClaimsCol.createIndex(
    { completedAt: 1 },
    { expireAfterSeconds: 24 * 60 * 60 },
  );
  // ensure stats doc exists
  const existing = await statsCol.findOne({});
  if (!existing) {
    await statsCol.insertOne({
      portfolioValue: 0,
      totalProfitSol: 0,
      totalProfitPercent: 0,
      openTrades: 0,
      tradeVolumeSol: 0,
      winRate: 0,
      lastUpdated: new Date(),
    });
  }
  log.info("Connected to MongoDB");
  return db;
}

export async function addTrade(
  tr: Omit<
    Partial<TradeRecord>,
    "amountSol" | "amountLamports" | "timestamp"
  > & { amount: number; timestamp?: Date | string },
) {
  if (!db) await connect();
  const timestamp = tr.timestamp ? new Date(tr.timestamp as any) : new Date();
  const lamports = Number(tr.amount || 0);
  const amountSol = lamports / 1e9;

  // normalize pnl passed in various formats
  let pnlPercent =
    typeof tr.pnl === "number"
      ? Math.abs(tr.pnl) <= 1
        ? tr.pnl
        : tr.pnl / 100
      : 0;
  const pnlSol = amountSol * pnlPercent;

  const record: TradeRecord = {
    id: (tr.id as string) || crypto.randomUUID(),
    type: (tr.type as "buy" | "sell") || "buy",
    token: (tr.token as string) || "UNKNOWN",
    amountLamports: lamports,
    amountSol,
    signature: tr.signature ?? null,
    timestamp,
    ...(tr.inputMint !== undefined && { inputMint: tr.inputMint }),
    ...(tr.outputMint !== undefined && { outputMint: tr.outputMint }),
    ...(tr.price !== undefined && { price: tr.price }),
    ...(pnlPercent !== 0 && { pnl: pnlPercent }),
    ...(pnlSol !== 0 && { pnlSol }),
    ...(tr.wallet !== undefined && { wallet: tr.wallet }),
    ...(tr.simulated !== undefined && { simulated: tr.simulated }),
  };

  await tradesCol!.insertOne(record);

  // Simulated trades don't represent real capital and must never contaminate
  // the persistent, cumulative stats shown on the dashboard (tradeVolumeSol/
  // totalProfitSol/openTrades are $inc'd forever, never reset, so even one
  // simulated trade slipping through here permanently inflates real numbers).
  if (!record.simulated) {
    // atomic stats update — openTrades is intentionally NOT $inc'd here (see
    // getStats(), which computes it live from actual current positions). A
    // running +1/-1 counter drifts from reality over time (e.g. dust-sized
    // "sells" against an already-closed position still decrement it) and,
    // unlike a live count, has no way to self-correct.
    const updated = await statsCol!.findOneAndUpdate(
      {},
      {
        $inc: {
          tradeVolumeSol: amountSol,
          totalProfitSol: pnlSol,
        },
        $set: { lastUpdated: new Date() },
      },
      { returnDocument: "after" },
    );

    // recompute winRate & percent (real trades only, same reasoning as above)
    const recent = await tradesCol!
      .find({ pnl: { $exists: true }, simulated: { $ne: true } })
      .sort({ timestamp: -1 })
      .limit(500)
      .toArray();
    const wins = recent.filter((r) => (r.pnl ?? 0) > 0).length;
    const winRate = recent.length ? (wins / recent.length) * 100 : 0;
    const statsDoc = updated!;
    const totalProfitPercent = statsDoc.tradeVolumeSol
      ? statsDoc.totalProfitSol / statsDoc.tradeVolumeSol
      : 0;

    await statsCol!.updateOne(
      {},
      {
        $set: {
          winRate,
          totalProfitPercent,
          portfolioValue: (statsDoc.portfolioValue || 0) + pnlSol,
        },
      },
    );
  }

  return record;
}

export async function claimDiscoveryMint(
  mint: string,
  ownerId: string,
  leaseMs = 2 * 60 * 1000,
): Promise<boolean> {
  if (!db) await connect();
  const now = new Date();
  const reclaimBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const claimed = await discoveryClaimsCol!.findOneAndUpdate(
    {
      mint,
      $or: [
        { status: "claimed", leaseUntil: { $lte: now } },
        { status: "completed", completedAt: { $lte: reclaimBefore } },
      ],
    },
    {
      $set: { ownerId, status: "claimed", claimedAt: now, leaseUntil },
      $unset: { completedAt: "" },
    },
    { returnDocument: "after" },
  );
  if (claimed?.ownerId === ownerId) return true;

  try {
    const inserted = await discoveryClaimsCol!.insertOne({
      mint,
      ownerId,
      status: "claimed",
      claimedAt: now,
      leaseUntil,
    });
    return inserted.acknowledged;
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

export async function completeDiscoveryMint(
  mint: string,
  ownerId: string,
): Promise<boolean> {
  if (!db) await connect();
  const result = await discoveryClaimsCol!.updateOne(
    { mint, ownerId, status: "claimed" },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        leaseUntil: new Date(),
      },
    },
  );
  return result.modifiedCount === 1;
}

export async function renewDiscoveryMint(
  mint: string,
  ownerId: string,
  leaseMs = 2 * 60 * 1000,
): Promise<boolean> {
  if (!db) await connect();
  const result = await discoveryClaimsCol!.updateOne(
    { mint, ownerId, status: "claimed" },
    { $set: { leaseUntil: new Date(Date.now() + leaseMs) } },
  );
  return result.modifiedCount === 1;
}

export async function releaseDiscoveryMint(
  mint: string,
  ownerId: string,
): Promise<boolean> {
  if (!db) await connect();
  const result = await discoveryClaimsCol!.deleteOne({
    mint,
    ownerId,
    status: "claimed",
  });
  return result.deletedCount === 1;
}

// The four functions below are PositionExitClaim's exact counterpart to the
// four DiscoveryClaim functions above — same lease-based
// findOneAndUpdate-then-insert claim, same completed-doc reclaim window,
// same TTL cleanup. Key difference: keyed by (token, wallet) instead of
// mint alone, since a sell decision belongs to one wallet's position, not
// to the token globally — two different wallets holding the same mint must
// be able to sell independently and concurrently.
export async function claimPositionExit(
  token: string,
  wallet: string,
  ownerId: string,
  leaseMs = 2 * 60 * 1000,
): Promise<boolean> {
  if (!db) await connect();
  const now = new Date();
  const reclaimBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const claimed = await positionExitClaimsCol!.findOneAndUpdate(
    {
      token,
      wallet,
      $or: [
        { status: "claimed", leaseUntil: { $lte: now } },
        { status: "completed", completedAt: { $lte: reclaimBefore } },
      ],
    },
    {
      $set: { ownerId, status: "claimed", claimedAt: now, leaseUntil },
      $unset: { completedAt: "" },
    },
    { returnDocument: "after" },
  );
  if (claimed?.ownerId === ownerId) return true;

  try {
    const inserted = await positionExitClaimsCol!.insertOne({
      token,
      wallet,
      ownerId,
      status: "claimed",
      claimedAt: now,
      leaseUntil,
    });
    return inserted.acknowledged;
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

export async function completePositionExit(
  token: string,
  wallet: string,
  ownerId: string,
): Promise<boolean> {
  if (!db) await connect();
  const result = await positionExitClaimsCol!.updateOne(
    { token, wallet, ownerId, status: "claimed" },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        leaseUntil: new Date(),
      },
    },
  );
  return result.modifiedCount === 1;
}

export async function renewPositionExit(
  token: string,
  wallet: string,
  ownerId: string,
  leaseMs = 2 * 60 * 1000,
): Promise<boolean> {
  if (!db) await connect();
  const result = await positionExitClaimsCol!.updateOne(
    { token, wallet, ownerId, status: "claimed" },
    { $set: { leaseUntil: new Date(Date.now() + leaseMs) } },
  );
  return result.modifiedCount === 1;
}

export async function releasePositionExit(
  token: string,
  wallet: string,
  ownerId: string,
): Promise<boolean> {
  if (!db) await connect();
  const result = await positionExitClaimsCol!.deleteOne({
    token,
    wallet,
    ownerId,
    status: "claimed",
  });
  return result.deletedCount === 1;
}

/**
 * Read-only lookup of the current sell-exit claim for one position, for
 * scripts/exit-check.ts. Never writes anything — just reports whether a sell
 * is currently claimed, by which process, and when that lease expires (a
 * claim past its leaseUntil is reclaimable by the next sell attempt; see
 * claimPositionExit above).
 */
export async function getPositionExitClaimState(
  token: string,
  wallet: string,
): Promise<PositionExitClaim | null> {
  if (!db) await connect();
  return positionExitClaimsCol!.findOne({ token, wallet });
}

/**
 * How many trades this wallet has ever taken — counts distinct tokens
 * bought, not raw buy-fill rows: a multi-fill buy (e.g. historical 2-tranche
 * buys from before the pipeline consolidation) can record more than one
 * "buy" TradeRecord for what a trader perceives as one trade/position, so
 * counting raw fills would silently double-count it. Used by
 * multiUserExecution.service.ts to enforce each wallet's own Max Total
 * Trades setting — computed live from real trade history rather than a
 * separate incrementing counter, so it can never drift (same reasoning as
 * getStats()'s openTrades).
 */
export async function getTotalTradesCount(wallet: string): Promise<number> {
  if (!db) await connect();
  const tokens = await tradesCol!.distinct("token", {
    wallet,
    type: "buy",
    simulated: { $ne: true },
  });
  return tokens.length;
}

// includeSimulated defaults to false — the same reasoning as getPositions():
// simulated trades don't represent real capital and must not silently
// contaminate real-money aggregates (daily-loss circuit breaker, PnL display,
// win rate). Callers that genuinely want the full picture (e.g. an admin
// audit view) can opt in explicitly.
export async function getTrades(
  limit = 50,
  includeSimulated = false,
  viewerWallet?: string,
) {
  if (!db) await connect();
  const filter = {
    ...(includeSimulated ? {} : { simulated: { $ne: true } }),
    ...viewerWalletFilter(viewerWallet),
  };
  return tradesCol!.find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
}

// The dust floor and the "is this position open?" rule live in
// utils/positionState.ts, shared with the monitor, the buy pipeline and the
// dashboard so they can't disagree (a position sold at a loss used to read as
// open forever — see that file).

const EMPTY_STATS = {
  portfolioValue: 0,
  totalProfitSol: 0,
  totalProfitPercent: 0,
  openTrades: 0,
  tradeVolumeSol: 0,
  winRate: 0,
};

export async function getStats(viewerWallet?: string) {
  if (!db) await connect();

  // No connected wallet — including the operator's own — means there's
  // nobody specific to show numbers for. The operator's own trades are that
  // wallet's own private activity now, same as any custodial user's: only
  // visible when THAT wallet (operator or otherwise) is the one connected,
  // never to an anonymous/disconnected viewer. (This used to fall back to
  // the operator's real numbers as a "public bot feed" — that was the exact
  // leak that made the operator's trade history visible without connecting
  // any wallet at all.)
  if (!viewerWallet) {
    return { ...EMPTY_STATS, lastUpdated: new Date() };
  }

  // Always computed fresh from the resolved wallet's own trades/positions —
  // never the stored statsCol doc, which $inc's across every wallet in the
  // system (see addTrade) and would blend every user's private numbers
  // together.
  const [positions, pnl] = await Promise.all([
    getPositions(viewerWallet),
    getPortfolioPnL(viewerWallet),
  ]);
  const openTrades = positions.filter((p) => isOpenPosition(p)).length;
  return {
    portfolioValue: pnl.openPositionsValue,
    totalProfitSol: pnl.totalPnlSol,
    totalProfitPercent: pnl.totalPnlPercent,
    openTrades,
    tradeVolumeSol: pnl.totalInvestedSol + pnl.totalReturnedSol,
    winRate: pnl.winRate,
    lastUpdated: new Date(),
  };
}

export type Position = {
  token: string;
  // The wallet this position belongs to (TradeRecord.wallet — the owner
  // wallet for custodial trades, see validationPipeline.service.ts). Needed
  // to know which wallet's keypair can actually sign a sell for this
  // position, and to keep two wallets holding the same token from being
  // treated as one merged position.
  wallet: string;
  // "self" = held in the connected wallet itself (manual trade, sellable by
  // the user signing directly), "custodial" = held in the server-managed hot
  // wallet (auto-trade, sellable only via the server's custodial keypair).
  // null for trades recorded before this field existed. Grouped into the
  // position identity below — a wallet that both manually holds AND has an
  // auto-bought position in the same token has two genuinely separate
  // holdings (different signer, different location on-chain), not one.
  custody: "self" | "custodial" | null;
  netSol: number;
  // Total SOL spent buying this position (see getDeployedSol).
  boughtSol?: number;
  // When the position was last sold from (see getBudgetState).
  lastSellAt?: Date | null;
  avgBuyPrice?: number;
  highestPnlPct?: number;
  trailingActivated?: boolean;
  soldAt40?: boolean; // Track if 30% sold at +40% profit
  soldAt80?: boolean; // Track if 30% sold at +80% profit
  soldAt150?: boolean; // Track if 30% sold at +150% profit
  remainingPct?: number; // Track remaining position percentage (starts at 100)
  firstTrancheEntry?: number; // Timestamp of first 60% buy
  secondTrancheEntry?: number; // Timestamp of second 40% buy
  tpPct?: number;
  slPct?: number;
  firstBuyAt?: Date; // Earliest buy fill for this token — used for the SL grace period
  sellFailureCount?: number; // Consecutive failed sell attempts — see PositionMetadata
  lastSellAttemptAt?: Date;
};

export async function recoverPositionCostBasis(
  token: string,
  wallet: string,
): Promise<number | null> {
  if (!db) await connect();
  const buys = await tradesCol!
    .find({ token, wallet, type: "buy", simulated: { $ne: true } })
    .toArray();
  let spentSol = 0;
  let tokenQuantity = 0;
  for (const buy of buys) {
    const amountSol = Number(buy.amountLamports) / 1e9;
    if (!Number.isFinite(amountSol) || amountSol <= 0) continue;
    const price = Number(buy.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    spentSol += amountSol;
    tokenQuantity += amountSol / price;
  }
  if (spentSol <= 0 || tokenQuantity <= 0) return null;
  return spentSol / tokenQuantity;
}

export async function getPositions(viewerWallet?: string): Promise<Position[]> {
  if (!db) await connect();
  const agg = await tradesCol!
    .aggregate([
      // Simulated trades don't represent real capital at risk and must never
      // count against MAX_OPEN_POSITIONS / risk-management position sizing.
      // viewerWalletFilter() is {} (no restriction) unless a specific
      // viewer's wallet was passed in — internal risk/monitoring callers
      // never pass one, so their view of "all real positions" is unchanged.
      {
        $match: {
          simulated: { $ne: true },
          ...viewerWalletFilter(viewerWallet),
        },
      },
      {
        $group: {
          // Compound identity: two different wallets holding the same token
          // are two separate positions, not one merged position — each has
          // its own cost basis, its own remaining size, and only one wallet
          // can actually sign a sell for it. custody is included too — the
          // same owner wallet can independently hold a manual (self-custody)
          // and an auto-bought (custodial) position in the same token, and
          // those live in two different on-chain wallets, so they can't be
          // netted together either.
          _id: { token: "$token", wallet: "$wallet", custody: "$custody" },
          bought: {
            $sum: { $cond: [{ $eq: ["$type", "buy"] }, "$amountLamports", 0] },
          },
          sold: {
            $sum: { $cond: [{ $eq: ["$type", "sell"] }, "$amountLamports", 0] },
          },
          // Token quantity received per buy fill, so avgBuyPrice below can be
          // weighted by how much was actually spent at each price rather than
          // averaging the price fields themselves. A plain $avg treats a 60%
          // tranche and a 40% tranche at different prices as equally
          // important, which biases the recorded cost basis away from what
          // was actually paid — and that biased number is what
          // monitor.service.ts's tiered take-profit and trailing-stop logic
          // fires against.
          buyTokenQty: {
            $sum: {
              $cond: [
                {
                  $and: [{ $eq: ["$type", "buy"] }, { $gt: ["$price", 0] }],
                },
                { $divide: ["$amountLamports", "$price"] },
                0,
              ],
            },
          },
          firstBuyAt: {
            $min: { $cond: [{ $eq: ["$type", "buy"] }, "$timestamp", null] },
          },
          // When the position was last sold from — a closed position's close
          // time, which a trading budget uses to count only losses realized
          // after the budget was set.
          lastSellAt: {
            $max: { $cond: [{ $eq: ["$type", "sell"] }, "$timestamp", null] },
          },
        },
      },
      {
        $project: {
          token: "$_id.token",
          wallet: "$_id.wallet",
          custody: { $ifNull: ["$_id.custody", null] },
          netSol: { $divide: [{ $subtract: ["$bought", "$sold"] }, 1e9] },
          // Total SOL spent buying this position — what a trading budget
          // counts as "at work" (netSol drops with every sale's proceeds, so
          // it understates the cost still tied up after a partial sale).
          boughtSol: { $divide: ["$bought", 1e9] },
          avgBuyPrice: {
            $cond: [
              { $gt: ["$buyTokenQty", 0] },
              { $divide: ["$bought", "$buyTokenQty"] },
              null,
            ],
          },
          firstBuyAt: 1,
          lastSellAt: 1,
          _id: 0,
        },
      },
    ])
    .toArray();

  // Merge with position metadata — tranche/tier fields included so
  // frontend/components/trading/TrancheProgress.tsx has real data to render
  // instead of permanently-undefined props.
  const positions = agg as Position[];
  for (const pos of positions) {
    const metadata = await positionMetadataCol!.findOne({
      token: pos.token,
      wallet: pos.wallet,
    });
    if (metadata) {
      if (metadata.highestPnlPct !== undefined) {
        pos.highestPnlPct = metadata.highestPnlPct;
      }
      if (metadata.trailingActivated !== undefined) {
        pos.trailingActivated = metadata.trailingActivated;
      }
      if (metadata.soldAt40 !== undefined) pos.soldAt40 = metadata.soldAt40;
      if (metadata.soldAt80 !== undefined) pos.soldAt80 = metadata.soldAt80;
      if (metadata.soldAt150 !== undefined) pos.soldAt150 = metadata.soldAt150;
      if (metadata.remainingPct !== undefined) {
        pos.remainingPct = metadata.remainingPct;
      }
      if (metadata.firstTrancheEntry !== undefined) {
        pos.firstTrancheEntry = metadata.firstTrancheEntry;
      }
      if (metadata.secondTrancheEntry !== undefined) {
        pos.secondTrancheEntry = metadata.secondTrancheEntry;
      }
      if (metadata.sellFailureCount !== undefined) {
        pos.sellFailureCount = metadata.sellFailureCount;
      }
      if (metadata.lastSellAttemptAt !== undefined) {
        pos.lastSellAttemptAt = metadata.lastSellAttemptAt;
      }
      if (metadata.tpPct !== undefined) pos.tpPct = metadata.tpPct;
      if (metadata.slPct !== undefined) pos.slPct = metadata.slPct;
    }
  }

  return positions;
}

/**
 * How many positions the BOT currently holds for this owner wallet — what
 * "Max Open Positions" counts. Self-custody (manual) positions are the user's
 * own and don't use one of the bot's slots; positions below the dust
 * threshold are economically closed (see getStats / monitor.service.ts).
 */
export async function getOpenPositionCount(
  ownerWallet: string,
): Promise<number> {
  const positions = await getPositions(ownerWallet);
  return positions.filter((p) => p.custody !== "self" && isOpenPosition(p))
    .length;
}

/**
 * SOL currently at work in the bot's open positions for this owner: what it
 * cost to buy the part of each position that is still held. This is the number
 * a trading budget is measured against (utils/positionSizing.ts).
 */
export async function getDeployedSol(ownerWallet: string): Promise<number> {
  return deployedSolOf(await getPositions(ownerWallet));
}

/**
 * Everything a trading budget needs from the ledger in one read: the SOL at
 * work in open positions, and the SOL lost on positions closed since the
 * budget was set (which permanently lowers the capital the bot may trade with).
 */
export async function getBudgetState(
  ownerWallet: string,
  budgetSetAtMs: number,
): Promise<{ deployedSol: number; realizedLossSol: number }> {
  const positions = await getPositions(ownerWallet);
  return {
    deployedSol: deployedSolOf(positions),
    realizedLossSol: realizedLossSolSince(positions, budgetSetAtMs),
  };
}

/**
 * PERMANENTLY deletes the trade history and monitoring record of the given
 * tokens for ONE wallet. There is no undo, and it changes realized P&L, win
 * rate and the lifetime trade count for that wallet — used only by
 * scripts/positions-cleanup.ts, which shows exactly what it will remove and
 * needs an explicit --yes.
 */
export async function purgePositionHistory(
  wallet: string,
  tokens: string[],
): Promise<{ tradesDeleted: number; metadataDeleted: number }> {
  if (!db) await connect();
  if (!wallet || tokens.length === 0) {
    return { tradesDeleted: 0, metadataDeleted: 0 };
  }
  const trades = await tradesCol!.deleteMany({
    wallet,
    token: { $in: tokens },
  });
  const meta = await positionMetadataCol!.deleteMany({
    wallet,
    token: { $in: tokens },
  });
  return {
    tradesDeleted: trades.deletedCount,
    metadataDeleted: meta.deletedCount,
  };
}

export async function updatePositionMetadata(
  token: string,
  wallet: string,
  updates: Partial<Omit<PositionMetadata, "token" | "wallet" | "updatedAt">>,
): Promise<void> {
  if (!db) await connect();
  await positionMetadataCol!.updateOne(
    { token, wallet },
    {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
      $setOnInsert: { token, wallet },
    },
    { upsert: true },
  );
}

export async function updateStats(updates: Partial<StatsDoc>) {
  if (!db) await connect();
  const out = await statsCol!.findOneAndUpdate(
    {},
    { $set: { ...updates, lastUpdated: new Date() } },
    { returnDocument: "after" },
  );
  // openTrades is never trustworthy from the stored document alone — it's a
  // point-in-time snapshot from whenever it was last $set (often never, since
  // most callers only touch portfolioValue/totalProfitSol/etc). Any caller
  // that broadcasts this return value (e.g. stats.route.ts's stats:update)
  // must get a figure that matches live positions, the same way getStats()
  // does, or the frontend can receive a stale/zero count that a `?? prev`
  // merge won't catch since 0 is not null/undefined.
  const positions = await getPositions();
  const openTrades = positions.filter((p) => isOpenPosition(p)).length;
  return { ...out!, openTrades };
}

/* ---------------------------------------
   WATCHLIST FUNCTIONS
---------------------------------------- */
export async function addToWatchlist(
  token: Omit<WatchlistToken, "_id" | "addedAt">,
) {
  if (!db) await connect();

  // Check if already exists
  const filter: any = { mint: token.mint };
  if (token.userId) filter.userId = token.userId;

  const existing = await watchlistCol!.findOne(filter);
  if (existing) {
    return { success: false, error: "Token already in watchlist", existing };
  }

  const doc: WatchlistToken = {
    ...token,
    addedAt: new Date(),
  };

  const result = await watchlistCol!.insertOne(doc as any);
  return { success: true, id: result.insertedId, doc };
}

export async function getWatchlist(userId?: string) {
  if (!db) await connect();
  const filter = userId ? { userId } : {};
  return watchlistCol!.find(filter).sort({ addedAt: -1 }).toArray();
}

export async function removeFromWatchlist(mint: string, userId?: string) {
  if (!db) await connect();
  const filter: any = { mint };
  if (userId) filter.userId = userId;

  const result = await watchlistCol!.deleteOne(filter);
  return {
    success: result.deletedCount > 0,
    deletedCount: result.deletedCount,
  };
}

export async function updateWatchlistAlert(
  mint: string,
  priceAlert: WatchlistToken["priceAlert"],
  userId?: string,
) {
  if (!db) await connect();
  const filter: any = { mint };
  if (userId) filter.userId = userId;

  const update: any = { $set: { priceAlert } };
  const result = await watchlistCol!.updateOne(filter, update);
  return {
    success: result.modifiedCount > 0,
    modifiedCount: result.modifiedCount,
  };
}

/* ---------------------------------------
   PORTFOLIO P&L TRACKING
---------------------------------------- */

/**
 * Calculate comprehensive portfolio P&L
 */
export async function getPortfolioPnL(
  viewerWallet?: string,
): Promise<PortfolioPnL> {
  if (!db) await connect();

  // Same reasoning as getPositions()/getTrades(): paper/simulated trades must
  // not contaminate real realized-PnL, win-rate, or invested-SOL figures —
  // this is what the dashboard actually displays to you.
  const trades = await tradesCol!
    .find({ simulated: { $ne: true }, ...viewerWalletFilter(viewerWallet) })
    .sort({ timestamp: 1 })
    .toArray();

  let totalInvestedSol = 0;
  let totalReturnedSol = 0;
  let realizedPnlSol = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalWinSol = 0;
  let totalLossSol = 0;
  let largestWinSol = 0;
  let largestLossSol = 0;

  for (const trade of trades) {
    if (trade.type === "buy") {
      totalInvestedSol += trade.amountSol;
    } else if (trade.type === "sell") {
      totalReturnedSol += trade.amountSol;

      if (trade.pnlSol) {
        realizedPnlSol += trade.pnlSol;

        if (trade.pnlSol > 0) {
          winningTrades++;
          totalWinSol += trade.pnlSol;
          largestWinSol = Math.max(largestWinSol, trade.pnlSol);
        } else if (trade.pnlSol < 0) {
          losingTrades++;
          totalLossSol += Math.abs(trade.pnlSol);
          largestLossSol = Math.max(largestLossSol, Math.abs(trade.pnlSol));
        }
      }
    }
  }

  // Get current open positions value
  const positions = await getPositions(viewerWallet);
  let unrealizedPnlSol = 0;
  let openPositionsValue = 0;

  for (const pos of positions) {
    // Only positions still open: summing every position's netSol let closed
    // ones distort this — profitable exits are negative, losing exits stay
    // positive — so it read as roughly (total returned - total invested)
    // instead of what is actually still deployed.
    if (isOpenPosition(pos)) openPositionsValue += pos.netSol;
    // Unrealized P&L would require current prices - placeholder for now
  }

  const totalTrades = winningTrades + losingTrades;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const averageWinSol = winningTrades > 0 ? totalWinSol / winningTrades : 0;
  const averageLossSol = losingTrades > 0 ? totalLossSol / losingTrades : 0;

  const totalPnlSol = realizedPnlSol + unrealizedPnlSol;
  const totalPnlPercent =
    totalInvestedSol > 0 ? (totalPnlSol / totalInvestedSol) * 100 : 0;

  const roi =
    totalInvestedSol > 0
      ? ((totalReturnedSol - totalInvestedSol) / totalInvestedSol) * 100
      : 0;

  return {
    totalInvestedSol,
    totalReturnedSol,
    unrealizedPnlSol,
    realizedPnlSol,
    totalPnlSol,
    totalPnlPercent,
    winningTrades,
    losingTrades,
    totalTrades,
    winRate,
    averageWinSol,
    averageLossSol,
    largestWinSol,
    largestLossSol,
    openPositionsValue,
    closedPositionsValue: totalReturnedSol,
    roi,
  };
}

/**
 * Get P&L breakdown by token
 */
export async function getTokenPnL(viewerWallet?: string): Promise<TokenPnL[]> {
  if (!db) await connect();

  const trades = await tradesCol!
    .find({ simulated: { $ne: true }, ...viewerWalletFilter(viewerWallet) })
    .sort({ timestamp: 1 })
    .toArray();
  const tokenMap = new Map<
    string,
    {
      totalBought: number;
      totalSold: number;
      buyCount: number;
      sellCount: number;
      symbol?: string;
    }
  >();

  for (const trade of trades) {
    const token = trade.token;
    if (!tokenMap.has(token)) {
      tokenMap.set(token, {
        totalBought: 0,
        totalSold: 0,
        buyCount: 0,
        sellCount: 0,
      });
    }

    const data = tokenMap.get(token)!;
    if (trade.type === "buy") {
      data.totalBought += trade.amountSol;
      data.buyCount++;
    } else if (trade.type === "sell") {
      data.totalSold += trade.amountSol;
      data.sellCount++;
    }
  }

  const tokenPnLs: TokenPnL[] = [];

  for (const [token, data] of tokenMap.entries()) {
    const pnlSol = data.totalSold - data.totalBought;
    const pnlPercent =
      data.totalBought > 0 ? (pnlSol / data.totalBought) * 100 : 0;

    const averageBuyPrice =
      data.buyCount > 0 ? data.totalBought / data.buyCount : 0;

    const status = data.totalSold >= data.totalBought ? "closed" : "open";
    const remainingTokens = data.totalBought - data.totalSold;

    tokenPnLs.push({
      token,
      symbol: token.substring(0, 8) + "...",
      totalBought: data.totalBought,
      totalSold: data.totalSold,
      remainingTokens,
      averageBuyPrice,
      pnlSol,
      pnlPercent,
      trades: data.buyCount + data.sellCount,
      status,
    });
  }

  // Sort by absolute P&L (largest gains/losses first)
  return tokenPnLs.sort((a, b) => Math.abs(b.pnlSol) - Math.abs(a.pnlSol));
}

/**
 * Get P&L history over time (daily aggregation)
 */
export async function getPnLHistory(
  days: number = 30,
  viewerWallet?: string,
): Promise<
  Array<{
    date: string;
    realizedPnlSol: number;
    tradeCount: number;
    winRate: number;
  }>
> {
  if (!db) await connect();

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const trades = await tradesCol!
    .find({
      timestamp: { $gte: startDate },
      type: "sell",
      simulated: { $ne: true },
      ...viewerWalletFilter(viewerWallet),
    })
    .sort({ timestamp: 1 })
    .toArray();

  const dailyMap = new Map<
    string,
    {
      pnl: number;
      wins: number;
      losses: number;
    }
  >();

  for (const trade of trades) {
    const dateKey = trade.timestamp.toISOString().split("T")[0];
    if (!dateKey) continue;

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, { pnl: 0, wins: 0, losses: 0 });
    }

    const day = dailyMap.get(dateKey)!;
    day.pnl += trade.pnlSol || 0;

    if (trade.pnlSol && trade.pnlSol > 0) day.wins++;
    else if (trade.pnlSol && trade.pnlSol < 0) day.losses++;
  }

  const history = Array.from(dailyMap.entries()).map(([date, data]) => {
    const total = data.wins + data.losses;
    return {
      date,
      realizedPnlSol: data.pnl,
      tradeCount: total,
      winRate: total > 0 ? (data.wins / total) * 100 : 0,
    };
  });

  return history.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Token State Management (for new trade rules)
 */
export async function upsertTokenState(
  tokenState: Omit<TokenState, "_id" | "updatedAt">,
): Promise<void> {
  if (!db) await connect();

  // Separate detectedAt from other fields to avoid MongoDB conflict
  const {
    detectedAt,
    launchMarketCapUSD,
    launchMarketCapSOL,
    launchLiquidityUSD,
    launchLiquiditySOL,
    poolCreatedAt,
    launchSnapshotAt,
    ...updateFields
  } = tokenState;

  await tokenStateCol!.updateOne(
    { mint: tokenState.mint },
    {
      $set: {
        ...updateFields,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        detectedAt: detectedAt || new Date(),
        ...(launchMarketCapUSD !== undefined && { launchMarketCapUSD }),
        ...(launchMarketCapSOL !== undefined && { launchMarketCapSOL }),
        ...(launchLiquidityUSD !== undefined && { launchLiquidityUSD }),
        ...(launchLiquiditySOL !== undefined && { launchLiquiditySOL }),
        ...(poolCreatedAt !== undefined && { poolCreatedAt }),
        ...(launchSnapshotAt !== undefined && { launchSnapshotAt }),
      },
    },
    { upsert: true },
  );
}

/**
 * Sets launchMarketCapSOL only if it isn't already recorded for this mint —
 * deliberately separate from upsertTokenState's own handling of this field
 * (routed through $setOnInsert there, which only ever fires on the row's
 * very first insert). This pipeline's first insert for a mint happens at
 * Phase 1/3 (see candidatePipeline.service.ts), before the Birdeye FDV data
 * this value is computed from even exists — by the time it's available
 * (Phase 4), the row already exists, so a second upsertTokenState call
 * would silently drop it via that same $setOnInsert behavior. This targets
 * the field directly with a conditional $set instead, while preserving the
 * same "first successful capture wins, never overwritten later" semantics
 * upsertTokenState's other launch-snapshot fields have.
 */
export async function setLaunchMarketCapIfUnset(
  mint: string,
  launchMarketCapSOL: number,
): Promise<void> {
  if (!db) await connect();
  await tokenStateCol!.updateOne(
    { mint, launchMarketCapSOL: { $exists: false } },
    { $set: { launchMarketCapSOL, updatedAt: new Date() } },
  );
}

export async function getTokenState(mint: string): Promise<TokenState | null> {
  if (!db) await connect();
  return await tokenStateCol!.findOne({ mint });
}

export async function getTokensByState(
  state: TokenLifecycleState,
): Promise<TokenState[]> {
  if (!db) await connect();
  return await tokenStateCol!.find({ state }).sort({ updatedAt: -1 }).toArray();
}

export async function getTokensByStates(
  states: TokenLifecycleState[],
  options?: {
    limit?: number;
    minCreatedAt?: Date;
    hasPool?: boolean;
  },
): Promise<TokenState[]> {
  if (!db) await connect();

  const filter: any = { state: { $in: states } };

  if (options?.minCreatedAt) {
    filter.detectedAt = { $gte: options.minCreatedAt };
  }

  if (options?.hasPool) {
    filter.poolAddress = { $exists: true, $ne: null };
  }

  let query = tokenStateCol!.find(filter).sort({ updatedAt: -1 });

  if (options?.limit) {
    query = query.limit(options.limit);
  }

  return await query.toArray();
}

export async function updateTokenState(
  mint: string,
  updates: Partial<Omit<TokenState, "_id" | "mint">>,
): Promise<void> {
  if (!db) await connect();
  await tokenStateCol!.updateOne(
    { mint },
    {
      $set: {
        ...updates,
        updatedAt: new Date(),
      },
    },
  );
}

export async function blacklistToken(
  mint: string,
  reason: string,
): Promise<void> {
  if (!db) await connect();
  await tokenStateCol!.updateOne(
    { mint },
    {
      $set: {
        state: "BLACKLISTED",
        blacklistedAt: new Date(),
        blacklistReason: reason,
        updatedAt: new Date(),
      },
    },
  );
}

export async function getUserSettings(
  wallet: string,
): Promise<UserSettings | null> {
  if (!db) await connect();
  return userSettingsCol!.findOne({ wallet });
}

export async function saveUserSettings(
  wallet: string,
  settings: Omit<UserSettings, "wallet" | "updatedAt">,
): Promise<UserSettings> {
  if (!db) await connect();
  const result = await userSettingsCol!.findOneAndUpdate(
    { wallet },
    {
      $set: { ...settings, updatedAt: new Date() },
      $setOnInsert: { wallet },
    },
    { upsert: true, returnDocument: "after" },
  );
  return result!;
}

const GLOBAL_AUTO_TRADE_SETTING_ID = "global-auto-trade";

export async function getGlobalAutoTradeEnabled(): Promise<boolean> {
  if (!db) await connect();
  const setting = await db!
    .collection<{ _id: string; enabled: boolean }>("systemSettings")
    .findOne({ _id: GLOBAL_AUTO_TRADE_SETTING_ID });
  return setting?.enabled ?? true;
}

export async function setGlobalAutoTradeEnabled(
  enabled: boolean,
): Promise<void> {
  if (!db) await connect();
  await db!
    .collection<{ _id: string; enabled: boolean; updatedAt: Date }>(
      "systemSettings",
    )
    .updateOne(
      { _id: GLOBAL_AUTO_TRADE_SETTING_ID },
      {
        $set: { enabled, updatedAt: new Date() },
        $setOnInsert: { _id: GLOBAL_AUTO_TRADE_SETTING_ID },
      },
      { upsert: true },
    );
}

export async function close() {
  if (client) {
    await client.close();
    client = null;
  }
}

export default {
  OPERATOR_WALLET,
  connect,
  addTrade,
  getTrades,
  getTotalTradesCount,
  getStats,
  getPositions,
  getOpenPositionCount,
  getDeployedSol,
  getBudgetState,
  getPositionExitClaimState,
  purgePositionHistory,
  recoverPositionCostBasis,
  updateStats,
  updatePositionMetadata,
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  updateWatchlistAlert,
  getPortfolioPnL,
  getTokenPnL,
  getPnLHistory,
  upsertTokenState,
  getTokenState,
  setLaunchMarketCapIfUnset,
  claimDiscoveryMint,
  completeDiscoveryMint,
  renewDiscoveryMint,
  releaseDiscoveryMint,
  claimPositionExit,
  completePositionExit,
  renewPositionExit,
  releasePositionExit,
  getTokensByState,
  getTokensByStates,
  updateTokenState,
  blacklistToken,
  getUserSettings,
  saveUserSettings,
  getGlobalAutoTradeEnabled,
  setGlobalAutoTradeEnabled,
  close,
};
