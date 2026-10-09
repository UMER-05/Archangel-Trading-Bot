const postMock = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...args: any[]) => postMock(...args) },
}));

import { Keypair } from "@solana/web3.js";
import {
  buildJitoTipInstruction,
  sendViaJitoBundle,
} from "../services/execution/transaction/jitoSender.js";

describe("jitoSender", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  // NOTE: fetchTipAccounts caches successful results at module scope for
  // 60s. These tests rely on execution order — the two fallback cases run
  // BEFORE the live-fetch-success case, so the cache is still empty and
  // each test genuinely exercises its own axios mock rather than silently
  // hitting a cache populated by an earlier test.
  describe("buildJitoTipInstruction", () => {
    it("falls back to the hardcoded tip account list if the live fetch fails", async () => {
      postMock.mockRejectedValue(new Error("network down"));
      const payer = Keypair.generate().publicKey;
      // Should not throw — falls back instead.
      const ix = await buildJitoTipInstruction(payer, 1000);
      expect(ix.keys.length).toBeGreaterThan(0);
    });

    it("falls back when the live fetch returns an empty/malformed result", async () => {
      postMock.mockResolvedValue({ data: { result: [] } });
      const payer = Keypair.generate().publicKey;
      const ix = await buildJitoTipInstruction(payer, 1000);
      expect(ix.keys.length).toBeGreaterThan(0);
    });

    it("builds a tip instruction using a live-fetched tip account", async () => {
      postMock.mockResolvedValue({
        data: { result: ["TipAccount1111111111111111111111111111111"] },
      });
      const payer = Keypair.generate().publicKey;
      const ix = await buildJitoTipInstruction(payer, 1000);
      expect(
        ix.keys.some(
          (k) =>
            k.pubkey.toBase58() === "TipAccount1111111111111111111111111111111",
        ),
      ).toBe(true);
    });
  });

  describe("sendViaJitoBundle", () => {
    it("resolves without throwing when the Block Engine returns a bundle id", async () => {
      postMock.mockResolvedValue({ data: { result: "bundle-id-123" } });
      await expect(
        sendViaJitoBundle(new Uint8Array([1, 2, 3])),
      ).resolves.toBeUndefined();
    });

    it("throws when the Block Engine returns a JSON-RPC error", async () => {
      postMock.mockResolvedValue({
        data: { error: { code: -32602, message: "invalid bundle" } },
      });
      await expect(
        sendViaJitoBundle(new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/invalid bundle/);
    });

    it("throws when the response has neither a result nor an error", async () => {
      postMock.mockResolvedValue({ data: {} });
      await expect(
        sendViaJitoBundle(new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/no bundle id/);
    });

    it("propagates a network-level failure", async () => {
      postMock.mockRejectedValue(new Error("timeout"));
      await expect(
        sendViaJitoBundle(new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/timeout/);
    });
  });
});
