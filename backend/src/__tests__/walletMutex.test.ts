// backend/src/__tests__/walletMutex.test.ts
import { withWalletLock } from "../utils/walletMutex.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withWalletLock", () => {
  it("serializes concurrent calls for the same wallet — the second only starts after the first finishes", async () => {
    const events: string[] = [];

    const first = withWalletLock("WALLET_A", async () => {
      events.push("first:start");
      await delay(30);
      events.push("first:end");
      return "first-result";
    });

    // Fired concurrently with `first`, same wallet — must not start until
    // `first` has actually finished (this is the real overdraw scenario:
    // two pipelines discovering different tokens for the same wallet at
    // nearly the same moment).
    const second = withWalletLock("WALLET_A", async () => {
      events.push("second:start");
      return "second-result";
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe("first-result");
    expect(secondResult).toBe("second-result");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block calls for a different wallet", async () => {
    const events: string[] = [];

    const walletA = withWalletLock("WALLET_A", async () => {
      events.push("A:start");
      await delay(30);
      events.push("A:end");
    });

    const walletB = withWalletLock("WALLET_B", async () => {
      events.push("B:start");
      await delay(5);
      events.push("B:end");
    });

    await Promise.all([walletA, walletB]);

    // B belongs to a different wallet, so it must be able to start (and
    // finish, given its shorter delay) before A finishes — not queued
    // behind it.
    expect(events.indexOf("B:start")).toBeLessThan(events.indexOf("A:end"));
    expect(events.indexOf("B:end")).toBeLessThan(events.indexOf("A:end"));
  });

  it("a rejected call does not wedge the queue for later calls on the same wallet", async () => {
    const first = withWalletLock("WALLET_C", async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    // Must still run — a failed buy must never permanently block every
    // future buy attempt for the same wallet.
    const second = await withWalletLock("WALLET_C", async () => "recovered");
    expect(second).toBe("recovered");
  });

  it("preserves order across more than two queued calls for the same wallet", async () => {
    const order: number[] = [];
    const calls = [1, 2, 3, 4].map((n) =>
      withWalletLock("WALLET_D", async () => {
        order.push(n);
        await delay(5);
      })
    );
    await Promise.all(calls);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
