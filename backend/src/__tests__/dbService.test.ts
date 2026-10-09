// backend/src/__tests__/dbService.test.ts
// Covers the financial/aggregation logic in db.service.ts — the area of the
// codebase that has repeatedly produced real bugs this project has hit
// (naive vs quantity-weighted avg cost basis, simulated trades leaking into
// real-money aggregates, lamports/SOL unit mixups). Runs against a real
// in-memory MongoDB (mongodb-memory-server), not mocks, so the actual
// aggregation pipelines are exercised end to end.
import { startTestDb, stopTestDb } from "./testDb.js";

let dbService: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  dbService = await startTestDb();
}, 300000);

afterAll(async () => {
  await stopTestDb();
});

describe("addTrade", () => {
  it("converts lamports to SOL and stores both", async () => {
    const record = await dbService.addTrade({
      type: "buy",
      token: "MINT_A",
      amount: 1_500_000_000, // 1.5 SOL in lamports
      price: 0.001,
    });
    expect(record.amountLamports).toBe(1_500_000_000);
    expect(record.amountSol).toBeCloseTo(1.5, 9);
  });

  it("treats a small numeric pnl as an already-decimal fraction, not a whole percent", async () => {
    // 0.4 must mean +40%, not +0.4%. This is the exact convention every
    // frontend consumer (trade-history.tsx, LiveTrades.tsx) depends on.
    const record = await dbService.addTrade({
      type: "sell",
      token: "MINT_PNL_A",
      amount: 1_000_000_000,
      price: 0.002,
      pnl: 0.4,
    });
    expect(record.pnl).toBeCloseTo(0.4, 9);
  });

  it("normalizes a whole-number pnl (e.g. 40 meaning 40%) down to a decimal fraction", async () => {
    const record = await dbService.addTrade({
      type: "sell",
      token: "MINT_PNL_B",
      amount: 1_000_000_000,
      price: 0.002,
      pnl: 40, // > 1 in magnitude, so treated as 40% not 4000%
    });
    expect(record.pnl).toBeCloseTo(0.4, 9);
  });

  it("does not increment real stats when a trade is marked simulated", async () => {
    const before = await dbService.getStats();
    await dbService.addTrade({
      type: "buy",
      token: "MINT_SIM",
      amount: 5_000_000_000, // 5 SOL — large enough to notice if it leaked through
      price: 0.01,
      simulated: true,
    });
    const after = await dbService.getStats();
    expect(after.tradeVolumeSol).toBeCloseTo(before.tradeVolumeSol, 9);
    expect(after.totalProfitSol).toBeCloseTo(before.totalProfitSol, 9);
  });

  it("does increment real stats for a non-simulated trade", async () => {
    // getStats() is wallet-scoped (see db.service.ts's viewerWalletFilter) —
    // every real trade carries a wallet, so this must too to be visible to
    // the same wallet's own getStats() call, matching real usage.
    const wallet = "TEST_WALLET_REAL_STATS";
    const before = await dbService.getStats(wallet);
    await dbService.addTrade({
      type: "buy",
      token: "MINT_REAL_STATS",
      amount: 2_000_000_000, // 2 SOL
      price: 0.01,
      wallet,
    });
    const after = await dbService.getStats(wallet);
    expect(after.tradeVolumeSol).toBeCloseTo(before.tradeVolumeSol + 2, 6);
  });
});

describe("getTrades simulated filtering", () => {
  it("excludes simulated trades by default", async () => {
    await dbService.addTrade({
      type: "buy",
      token: "MINT_FILTER",
      amount: 1_000_000_000,
      price: 0.001,
      simulated: true,
    });
    const trades = await dbService.getTrades(500, false);
    expect(trades.some((t) => t.token === "MINT_FILTER")).toBe(false);
  });

  it("includes simulated trades when includeSimulated=true", async () => {
    const trades = await dbService.getTrades(500, true);
    expect(trades.some((t) => t.token === "MINT_FILTER")).toBe(true);
  });
});

describe("getPositions — quantity-weighted average cost basis", () => {
  it("weights avgBuyPrice by SOL spent per tranche, not a naive average of prices", async () => {
    const token = "MINT_TRANCHE";
    // Tranche 1: 0.6 SOL at price 0.001 SOL/token -> 600 tokens
    await dbService.addTrade({
      type: "buy",
      token,
      amount: 600_000_000,
      price: 0.001,
    });
    // Tranche 2: 0.4 SOL at price 0.002 SOL/token -> 200 tokens
    await dbService.addTrade({
      type: "buy",
      token,
      amount: 400_000_000,
      price: 0.002,
    });

    const positions = await dbService.getPositions();
    const pos = positions.find((p) => p.token === token);
    expect(pos).toBeDefined();

    // Total spent 1.0 SOL for 800 tokens => weighted avg = 1.0/800 = 0.00125
    // A naive average of the two price fields would wrongly give 0.0015.
    expect(pos!.avgBuyPrice).toBeCloseTo(0.00125, 9);
    expect(pos!.netSol).toBeCloseTo(1.0, 9);
  });

  it("excludes simulated trades from position sizing entirely", async () => {
    const token = "MINT_SIM_POSITION";
    await dbService.addTrade({
      type: "buy",
      token,
      amount: 3_000_000_000,
      price: 0.001,
      simulated: true,
    });
    const positions = await dbService.getPositions();
    expect(positions.some((p) => p.token === token)).toBe(false);
  });

  it("nets buys and sells into a shrinking position", async () => {
    const token = "MINT_PARTIAL_SELL";
    await dbService.addTrade({
      type: "buy",
      token,
      amount: 1_000_000_000,
      price: 0.001,
    });
    await dbService.addTrade({
      type: "sell",
      token,
      amount: 400_000_000,
      price: 0.0015,
    });
    const positions = await dbService.getPositions();
    const pos = positions.find((p) => p.token === token);
    expect(pos!.netSol).toBeCloseTo(0.6, 9);
  });
});

describe("getStats — openTrades is derived live, not a drifting counter", () => {
  it("counts openTrades from actual current positions above the dust threshold", async () => {
    // getStats()/getPositions() are wallet-scoped when a wallet is passed
    // (see db.service.ts's viewerWalletFilter) — tag both calls with the
    // same wallet, matching how every real trade is recorded today.
    const wallet = "TEST_WALLET_OPEN_COUNT";
    const token = "MINT_OPEN_COUNT";
    await dbService.addTrade({
      type: "buy",
      token,
      amount: 1_000_000_000,
      price: 0.001,
      wallet,
    });
    const statsWithOpen = await dbService.getStats(wallet);
    const positions = await dbService.getPositions(wallet);
    const expectedOpen = positions.filter((p) => p.netSol >= 0.0005).length;
    expect(statsWithOpen.openTrades).toBe(expectedOpen);

    // Fully close the position — it must drop out of openTrades immediately,
    // not require a separate decrement step anywhere.
    await dbService.addTrade({
      type: "sell",
      token,
      amount: 1_000_000_000,
      price: 0.001,
      wallet,
    });
    const statsAfterClose = await dbService.getStats(wallet);
    const positionsAfterClose = await dbService.getPositions(wallet);
    const stillOpen = positionsAfterClose.find((p) => p.token === token);
    expect(stillOpen ? stillOpen.netSol < 0.0005 : true).toBe(true);
    expect(statsAfterClose.openTrades).toBe(
      positionsAfterClose.filter((p) => p.netSol >= 0.0005).length,
    );
  });
});

describe("watchlist CRUD", () => {
  it("adds, lists, and removes a token", async () => {
    const mint = "MINT_WATCHLIST_1";
    const added = await dbService.addToWatchlist({ mint, symbol: "TST" });
    expect(added.success).toBe(true);

    const list = await dbService.getWatchlist();
    expect(list.some((t) => t.mint === mint)).toBe(true);

    const removed = await dbService.removeFromWatchlist(mint);
    expect(removed.success).toBe(true);

    const listAfter = await dbService.getWatchlist();
    expect(listAfter.some((t) => t.mint === mint)).toBe(false);
  });

  it("refuses to add the same mint twice", async () => {
    const mint = "MINT_WATCHLIST_DUP";
    await dbService.addToWatchlist({ mint, symbol: "DUP" });
    const second = await dbService.addToWatchlist({ mint, symbol: "DUP" });
    expect(second.success).toBe(false);
  });

  it("sets a price alert on a watched token", async () => {
    const mint = "MINT_WATCHLIST_ALERT";
    await dbService.addToWatchlist({ mint, symbol: "ALT" });
    const result = await dbService.updateWatchlistAlert(mint, {
      targetPrice: 0.05,
      condition: "above",
      triggered: false,
    });
    expect(result.success).toBe(true);
    const list = await dbService.getWatchlist();
    const entry = list.find((t) => t.mint === mint);
    expect(entry?.priceAlert?.targetPrice).toBe(0.05);
  });
});

describe("user settings persistence", () => {
  it("round-trips real settings for a wallet", async () => {
    const wallet = "TestWallet1111111111111111111111111111111";
    await dbService.saveUserSettings(wallet, {
      autoTrade: true,
    });

    const loaded = await dbService.getUserSettings(wallet);
    expect(loaded?.autoTrade).toBe(true);
  });

  it("returns null for a wallet that never saved settings", async () => {
    const loaded = await dbService.getUserSettings(
      "NeverSavedWallet22222222222222222222222222",
    );
    expect(loaded).toBeNull();
  });
});
