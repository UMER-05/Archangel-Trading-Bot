import request from "supertest";
import { startTestDb, stopTestDb } from "./testDb.js";

let app: import("express").Express;

beforeAll(async () => {
  await startTestDb();
  // createApp() is imported dynamically, after MONGO_URI is pointed at the
  // in-memory instance — a static top-of-file import would have already
  // pulled in db.service.ts (via app.ts) before that env var was set.
  const { createApp } = await import("../app.js");
  app = createApp();
}, 300000);

afterAll(async () => {
  await stopTestDb();
});

describe("Old Tokens API", () => {
  it("should return a list of old tokens", async () => {
    const res = await request(app).get("/api/old-tokens");
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("tokens");
    expect(Array.isArray(res.body.tokens)).toBe(true);
  });

  it("404s a detail lookup for a token that doesn't exist", async () => {
    const res = await request(app).get(
      "/api/old-tokens/NoSuchMint1111111111111111111111111111111"
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
