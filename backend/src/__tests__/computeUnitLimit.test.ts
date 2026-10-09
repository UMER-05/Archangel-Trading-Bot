import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { determineComputeUnitLimit } from "../services/execution/raydium/cpmm.js";

// A minimal, structurally valid V0 transaction — content doesn't matter,
// determineComputeUnitLimit only decompiles/recompiles it, it never
// inspects what the instructions actually do.
function makeFakeTransaction(payer: ReturnType<typeof Keypair.generate>) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message([]);
  return new VersionedTransaction(message);
}

function makeConnection(overrides: Partial<any> = {}) {
  return {
    getLatestBlockhash: jest
      .fn()
      .mockResolvedValue({ blockhash: "bh1", lastValidBlockHeight: 100 }),
    getAddressLookupTable: jest.fn().mockResolvedValue({ value: null }),
    simulateTransaction: jest
      .fn()
      .mockResolvedValue({ value: { err: null, unitsConsumed: 150_000 } }),
    ...overrides,
  };
}

describe("determineComputeUnitLimit", () => {
  const ORIGINAL = process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT;
  const keypair = Keypair.generate();
  const tx = makeFakeTransaction(keypair);

  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT;
    else process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT = ORIGINAL;
  });

  it("applies the safety margin to a successful simulation's unitsConsumed", async () => {
    const connection = makeConnection();
    const limit = await determineComputeUnitLimit(
      connection as any,
      tx,
      keypair,
      {},
      "test",
    );
    // 150_000 * 1.2 margin = 180_000
    expect(limit).toBe(180_000);
  });

  it("falls back to the configured/default limit when simulation reports an error", async () => {
    process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT = "250000";
    const connection = makeConnection({
      simulateTransaction: jest.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, "Custom"] } },
      }),
    });
    const limit = await determineComputeUnitLimit(
      connection as any,
      tx,
      keypair,
      {},
      "test",
    );
    expect(limit).toBe(250_000);
  });

  it("falls back to the configured/default limit when unitsConsumed is missing", async () => {
    process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT = "300000";
    const connection = makeConnection({
      simulateTransaction: jest
        .fn()
        .mockResolvedValue({ value: { err: null } }),
    });
    const limit = await determineComputeUnitLimit(
      connection as any,
      tx,
      keypair,
      {},
      "test",
    );
    expect(limit).toBe(300_000);
  });

  it("falls back to the configured/default limit when simulation itself throws", async () => {
    process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT = "275000";
    const connection = makeConnection({
      simulateTransaction: jest.fn().mockRejectedValue(new Error("RPC down")),
    });
    const limit = await determineComputeUnitLimit(
      connection as any,
      tx,
      keypair,
      {},
      "test",
    );
    expect(limit).toBe(275_000);
  });

  it("never returns below the minimum floor even for a tiny unitsConsumed", async () => {
    const connection = makeConnection({
      simulateTransaction: jest
        .fn()
        .mockResolvedValue({ value: { err: null, unitsConsumed: 100 } }),
    });
    const limit = await determineComputeUnitLimit(
      connection as any,
      tx,
      keypair,
      {},
      "test",
    );
    expect(limit).toBeGreaterThanOrEqual(20_000);
  });

  it("never exceeds Solana's per-transaction compute ceiling", async () => {
    const connection = makeConnection({
      simulateTransaction: jest
        .fn()
        .mockResolvedValue({ value: { err: null, unitsConsumed: 2_000_000 } }),
    });
    const limit = await determineComputeUnitLimit(
      connection as any,
      tx,
      keypair,
      {},
      "test",
    );
    expect(limit).toBeLessThanOrEqual(1_400_000);
  });
});
