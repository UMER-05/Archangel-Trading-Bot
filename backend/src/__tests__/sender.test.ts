import { sendAndConfirmWithRetry } from "../services/execution/transaction/sender.js";

function makeConnection(overrides: Partial<any> = {}) {
  return {
    getLatestBlockhash: jest
      .fn()
      .mockResolvedValue({ blockhash: "bh1", lastValidBlockHeight: 100 }),
    sendRawTransaction: jest.fn().mockResolvedValue("sig1"),
    getSignatureStatuses: jest.fn().mockResolvedValue({ value: [null] }),
    ...overrides,
  };
}

const fakeTx = {
  serialize: () => Buffer.from([1, 2, 3]),
  signatures: [new Uint8Array(64).fill(7)],
} as any;
const buildTx = jest.fn().mockResolvedValue(fakeTx);

describe("sendAndConfirmWithRetry", () => {
  beforeEach(() => {
    buildTx.mockClear();
  });

  it("returns confirmed as soon as the signature status shows confirmed", async () => {
    const connection = makeConnection({
      getSignatureStatuses: jest.fn().mockResolvedValue({
        value: [{ err: null, confirmationStatus: "confirmed" }],
      }),
    });

    const result = await sendAndConfirmWithRetry(connection as any, buildTx, {
      initialComputeUnitPriceMicroLamports: 1000,
      pollIntervalMs: 1,
      confirmTimeoutMs: 100,
    });

    expect(result.outcome).toBe("confirmed");
    expect(buildTx).toHaveBeenCalledTimes(1);
  });

  it("returns reverted (not retryable) when the signature landed with an on-chain error", async () => {
    const connection = makeConnection({
      getSignatureStatuses: jest.fn().mockResolvedValue({
        value: [{ err: { InstructionError: [0, "Custom"] } }],
      }),
    });

    const result = await sendAndConfirmWithRetry(connection as any, buildTx, {
      initialComputeUnitPriceMicroLamports: 1000,
      pollIntervalMs: 1,
      confirmTimeoutMs: 100,
    });

    expect(result.outcome).toBe("reverted");
    expect(buildTx).toHaveBeenCalledTimes(1);
  });

  it("bumps priority fee and rebuilds on a genuine timeout retry", async () => {
    let call = 0;
    const connection = makeConnection({
      getSignatureStatuses: jest.fn().mockImplementation(async () => {
        call += 1;
        // Never confirmed on attempt 1's polling; confirmed once attempt 2 sends.
        if (call <= 2) return { value: [null] };
        return { value: [{ err: null, confirmationStatus: "confirmed" }] };
      }),
    });

    const result = await sendAndConfirmWithRetry(connection as any, buildTx, {
      initialComputeUnitPriceMicroLamports: 1000,
      priorityFeeBumpMultiplier: 2,
      pollIntervalMs: 1,
      confirmTimeoutMs: 5,
      maxAttempts: 3,
    });

    expect(result.outcome).toBe("confirmed");
    expect(buildTx).toHaveBeenCalledTimes(2);
    // Second call's priority fee should be bumped from the first.
    const firstCallArgs = buildTx.mock.calls[0][0];
    const secondCallArgs = buildTx.mock.calls[1][0];
    expect(secondCallArgs.computeUnitPriceMicroLamports).toBeGreaterThan(
      firstCallArgs.computeUnitPriceMicroLamports,
    );
  });

  it("does NOT resend if the previous attempt's signature confirmed while preparing a retry (double-execution guard)", async () => {
    let statusCallCount = 0;
    const connection = makeConnection({
      getSignatureStatuses: jest.fn().mockImplementation(async () => {
        statusCallCount += 1;
        // Times out during attempt 1's own polling window (always null there),
        // but by the time the retry guard re-checks, it's confirmed.
        if (statusCallCount <= 5) return { value: [null] };
        return { value: [{ err: null, confirmationStatus: "confirmed" }] };
      }),
    });

    const result = await sendAndConfirmWithRetry(connection as any, buildTx, {
      initialComputeUnitPriceMicroLamports: 1000,
      pollIntervalMs: 1,
      confirmTimeoutMs: 3,
      maxAttempts: 3,
    });

    expect(result.outcome).toBe("confirmed");
    // Only one transaction should ever have been sent — the guard caught
    // the late confirmation before a second sendRawTransaction happened.
    expect(buildTx).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns unknown (never a plain failure) when every attempt times out", async () => {
    const connection = makeConnection({
      getSignatureStatuses: jest.fn().mockResolvedValue({ value: [null] }),
    });

    const result = await sendAndConfirmWithRetry(connection as any, buildTx, {
      initialComputeUnitPriceMicroLamports: 1000,
      pollIntervalMs: 1,
      confirmTimeoutMs: 3,
      maxAttempts: 2,
    });

    expect(result.outcome).toBe("unknown");
    if (result.outcome === "unknown") {
      expect(result.reason).toMatch(/reconcile/i);
    }
  });

  it("uses a custom send transport instead of connection.sendRawTransaction when provided", async () => {
    const connection = makeConnection({
      getSignatureStatuses: jest.fn().mockResolvedValue({
        value: [{ err: null, confirmationStatus: "confirmed" }],
      }),
    });
    const customSend = jest.fn().mockResolvedValue(undefined);

    const result = await sendAndConfirmWithRetry(connection as any, buildTx, {
      initialComputeUnitPriceMicroLamports: 1000,
      pollIntervalMs: 1,
      confirmTimeoutMs: 100,
      send: customSend,
    });

    expect(result.outcome).toBe("confirmed");
    expect(customSend).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    // Signature is derived from the built transaction itself, not from
    // the transport's return value (customSend resolves to undefined).
    if (result.outcome === "confirmed") {
      expect(result.signature).toEqual(expect.any(String));
      expect(result.signature.length).toBeGreaterThan(0);
    }
  });

  it("propagates a custom transport's thrown error the same way a broken sendRawTransaction would", async () => {
    const connection = makeConnection();
    const failingSend = jest
      .fn()
      .mockRejectedValue(new Error("Block Engine unreachable"));

    await expect(
      sendAndConfirmWithRetry(connection as any, buildTx, {
        initialComputeUnitPriceMicroLamports: 1000,
        pollIntervalMs: 1,
        confirmTimeoutMs: 100,
        send: failingSend,
      }),
    ).rejects.toThrow(/Block Engine unreachable/);
  });
});
