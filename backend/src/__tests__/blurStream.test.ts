import { extractCandidateMintFromBlurEvent } from "../services/blurExtraction.service.js";
import { buildBlurUrl } from "../services/blurStream.service.js";

// blurStream.service pulls in the whole candidate pipeline (DB, Jupiter, ...)
// and the alert channels; none of that is under test here.
jest.mock("../services/candidatePipeline.service.js", () => ({
  __esModule: true,
  processCandidateMint: jest.fn(),
  default: {},
}));
jest.mock("../services/notifications/notify.service.js", () => ({
  __esModule: true,
  notifyError: jest.fn(),
  default: {},
}));
jest.mock("ws", () => ({ __esModule: true, default: class {} }));

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT = "AqCMmSk3HurEQrxdzb4AGFkCWJbUGP37SJwe2NkwhBU3";
const POOL = "AiwpimweSeqEjagMJ6Z6TEqdwugFcZuXhxNwqqBDMvQB";
const CREATOR = "A4BHgbmmpHknHkjwnthhVNUU2WRHiCYxLHM7aJJ4bLNA";
const OTHER_TOKEN = "LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD";

// Shape taken from a real Blur pool_create frame.
const frame = (over: Record<string, unknown> = {}) => ({
  signature:
    "3aobbzEp5t9ZUMUtExQZUrUZvog1uU5bRVFDscF8uNQNhbizr4f1fd5bxcnVm7StANZN9KQC14cd9wuVCVjA1acc",
  slot: 448412028,
  block_time: 1789822059,
  dex: "raydium_launchpad",
  mint: MINT,
  pool: POOL,
  base_mint: MINT,
  quote_mint: SOL,
  creator: CREATOR,
  indexed_at: 1789822060137,
  type: "pool_create",
  ...over,
});

describe("extractCandidateMintFromBlurEvent", () => {
  it("extracts a SOL-quoted pool_create", () => {
    expect(extractCandidateMintFromBlurEvent(frame())).toEqual({
      mint: MINT,
      poolAddress: POOL,
      dex: "raydium_launchpad",
      poolCreatedAt: new Date(1789822059 * 1000),
    });
  });

  it("finds the new token when the quote asset is on the base side", () => {
    const c = extractCandidateMintFromBlurEvent(
      frame({ base_mint: USDC, quote_mint: MINT }),
    );
    expect(c?.mint).toBe(MINT);
  });

  it("falls back to `mint` when base_mint is absent", () => {
    const c = extractCandidateMintFromBlurEvent(
      frame({ base_mint: undefined }),
    );
    expect(c?.mint).toBe(MINT);
  });

  it("rejects a pool with no SOL/USDC/USDT side (launchpad token quoted in another token)", () => {
    expect(
      extractCandidateMintFromBlurEvent(frame({ quote_mint: OTHER_TOKEN })),
    ).toBeNull();
  });

  it("rejects a pool where both sides are quote assets", () => {
    expect(
      extractCandidateMintFromBlurEvent(
        frame({ base_mint: USDC, quote_mint: SOL }),
      ),
    ).toBeNull();
  });

  it("ignores other event types", () => {
    expect(
      extractCandidateMintFromBlurEvent(frame({ type: "token_create" })),
    ).toBeNull();
    expect(
      extractCandidateMintFromBlurEvent(frame({ type: "swap" })),
    ).toBeNull();
  });

  it("rejects missing/invalid fields", () => {
    expect(extractCandidateMintFromBlurEvent(null)).toBeNull();
    expect(extractCandidateMintFromBlurEvent("pool_create")).toBeNull();
    expect(
      extractCandidateMintFromBlurEvent(frame({ block_time: 0 })),
    ).toBeNull();
    expect(
      extractCandidateMintFromBlurEvent(frame({ block_time: "1789822059" })),
    ).toBeNull();
    expect(
      extractCandidateMintFromBlurEvent(frame({ pool: "not-a-pubkey" })),
    ).toBeNull();
    expect(extractCandidateMintFromBlurEvent(frame({ dex: "" }))).toBeNull();
  });
});

describe("buildBlurUrl", () => {
  it("subscribes to pool_create only, with the key in the query", () => {
    const { url } = buildBlurUrl({
      baseUrl: "wss://ws.solami.dev/data/subscribe",
      apiKey: "sk_test_123",
    });
    const u = new URL(url);
    expect(u.origin).toBe("wss://ws.solami.dev");
    expect(u.pathname).toBe("/data/subscribe");
    expect(u.searchParams.get("chain")).toBe("solana");
    expect(u.searchParams.get("type")).toBe("pool_create");
    expect(u.searchParams.get("metadata")).toBe("false");
    expect(u.searchParams.get("api_key")).toBe("sk_test_123");
    expect(u.searchParams.has("dex")).toBe(false);
  });

  it("never puts the key in the loggable form of the URL", () => {
    const { safeUrl } = buildBlurUrl({
      baseUrl: "wss://fra.ws.solami.dev/data/subscribe",
      apiKey: "sk_test_123",
    });
    expect(safeUrl).toBe("wss://fra.ws.solami.dev/data/subscribe");
    expect(safeUrl).not.toContain("sk_test_123");
  });

  it("passes a DEX allow-list as a comma-separated dex param", () => {
    const { url } = buildBlurUrl({
      baseUrl: "wss://ws.solami.dev/data/subscribe",
      apiKey: "k",
      dexes: ["raydium_cpmm", "pumpswap"],
    });
    expect(new URL(url).searchParams.get("dex")).toBe("raydium_cpmm,pumpswap");
  });
});
