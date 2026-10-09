// backend/src/__tests__/routes.test.ts
// Integration tests for key HTTP routes via supertest against a real
// createApp() instance and a real in-memory MongoDB. Routes that depend on
// live external APIs (price data) are mocked so the suite stays
// fast and doesn't require network access to pass.
import request from "supertest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { startTestDb, stopTestDb } from "./testDb.js";

jest.mock("../services/jupiter.service.js", () => ({
  __esModule: true,
  getSolPriceUsd: jest.fn().mockResolvedValue(200),
  getQuoteImpliedPriceSol: jest.fn().mockResolvedValue(0.002),
  SOL_MINT: "So11111111111111111111111111111111111111112",
  default: {
    getSolPriceUsd: jest.fn().mockResolvedValue(200),
  },
}));

// positions.route.ts prices open positions via a small reference Jupiter
// quote (Birdeye has been removed from this codebase entirely) — decimals
// come from an on-chain mint-account lookup, so that needs mocking too.
jest.mock("../services/tokenSafetyChecks.service.js", () => ({
  __esModule: true,
  getOnChainMintSupply: jest.fn().mockResolvedValue({
    decimals: 9,
    supply: 1_000_000_000,
    available: true,
  }),
}));

let app: import("express").Express;
let dbService: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  dbService = await startTestDb();
  const { createApp } = await import("../app.js");
  app = createApp();
}, 300000);

afterAll(async () => {
  await stopTestDb();
});

describe("GET /api/tokens/sol-price", () => {
  it("returns the live (mocked) SOL/USD price", async () => {
    const res = await request(app).get("/api/tokens/sol-price");
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.price).toBe(200);
  });
});

describe("GET /api/positions", () => {
  it("returns an empty list when nothing is held", async () => {
    const res = await request(app).get("/api/positions");
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.positions).toEqual([]);
  });

  it("enriches a real position with live price and a correctly-signed unrealized PnL", async () => {
    // /api/positions is wallet-scoped (see positions.route.ts); every real
    // trade carries a wallet, so this must too, and the request must ask
    // for that same wallet to see it back.
    const wallet = "RouteTestWalletPosition2222222222222222222";
    await dbService.addTrade({
      type: "buy",
      token: "MINT_ROUTE_POSITION",
      amount: 1_000_000_000, // 1 SOL
      price: 0.001, // avgBuyPrice in SOL
      wallet,
    });

    const res = await request(app).get(`/api/positions?wallet=${wallet}`);
    expect(res.statusCode).toBe(200);
    const pos = res.body.positions.find(
      (p: any) => p.token === "MINT_ROUTE_POSITION",
    );
    expect(pos).toBeDefined();

    // Mocked current price: 0.002 SOL (getQuoteImpliedPriceSol above), double
    // the 0.001 SOL avgBuyPrice, so this position should show as up ~100%.
    expect(pos.currentPrice).toBeCloseTo(0.002, 9);
    expect(pos.unrealizedPnlPct).toBeCloseTo(1.0, 6);
    expect(pos.unrealizedPnlSol).toBeGreaterThan(0);
  });
});

describe("POST/GET /api/user/settings — real persistence round-trip", () => {
  // POST requires a real wallet-signature proof (see user.route.ts's
  // verifyWalletAuth) — a fixed placeholder string can't produce one, so
  // this uses a real generated keypair, matching how the frontend actually
  // signs the auth message via the connected wallet's signMessage.
  const testWalletKeypair = Keypair.generate();
  const wallet = testWalletKeypair.publicKey.toBase58();

  function signWalletAuth() {
    const timestamp = Date.now();
    const message = `ArchAngel auth\nwallet: ${wallet}\ntimestamp: ${timestamp}`;
    const signature = nacl.sign.detached(
      new TextEncoder().encode(message),
      testWalletKeypair.secretKey,
    );
    return {
      walletAuthTimestamp: timestamp,
      walletAuthSignature: bs58.encode(signature),
    };
  }

  it("400s without a wallet", async () => {
    const res = await request(app)
      .post("/api/user/settings")
      .send({ autoMode: true });
    expect(res.statusCode).toBe(400);
  });

  it("saves settings for a wallet and reads them back unchanged", async () => {
    const saveRes = await request(app)
      .post("/api/user/settings")
      .send({
        wallet,
        autoTrade: true,
        ...signWalletAuth(),
      });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.success).toBe(true);

    const loadRes = await request(app).get(
      `/api/user/settings?wallet=${wallet}`,
    );
    expect(loadRes.statusCode).toBe(200);
    expect(loadRes.body.data.autoTrade).toBe(true);
  });

  it("400s a GET without a wallet query param", async () => {
    const res = await request(app).get("/api/user/settings");
    expect(res.statusCode).toBe(400);
  });
});

describe("Watchlist routes", () => {
  const mint = "RouteTestMint4444444444444444444444444444";

  it("adds, lists, and deletes a token via HTTP", async () => {
    const addRes = await request(app)
      .post("/api/watchlist")
      .send({ mint, symbol: "RTM" });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.body.success).toBe(true);

    const listRes = await request(app).get("/api/watchlist");
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.tokens.some((t: any) => t.mint === mint)).toBe(true);

    const delRes = await request(app).delete(`/api/watchlist/${mint}`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.success).toBe(true);
  });

  it("400s adding a token with no mint", async () => {
    const res = await request(app).post("/api/watchlist").send({});
    expect(res.statusCode).toBe(400);
  });

  it("404s deleting a mint that was never watched", async () => {
    const res = await request(app).delete(
      "/api/watchlist/NeverWatchedMint555555555555555555555555",
    );
    expect(res.statusCode).toBe(404);
  });

  it("sets a price alert with a valid condition and rejects an invalid one", async () => {
    await request(app).post("/api/watchlist").send({ mint, symbol: "RTM" });

    const bad = await request(app)
      .patch(`/api/watchlist/${mint}/alert`)
      .send({ targetPrice: 1, condition: "sideways" });
    expect(bad.statusCode).toBe(400);

    const good = await request(app)
      .patch(`/api/watchlist/${mint}/alert`)
      .send({ targetPrice: 1, condition: "above" });
    expect(good.statusCode).toBe(200);
  });
});
