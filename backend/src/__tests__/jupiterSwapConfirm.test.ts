// backend/src/__tests__/jupiterSwapConfirm.test.ts
// A Jupiter swap that lands in a block but REVERTS (slippage exceeded, pool
// changed) still "confirms" — with `err` set. executeSwap used to report that
// as success, so the monitor recorded a sale that never happened, marked the
// position closed and left the tokens stranded in the hot wallet. One wallet
// had 20+ such positions. This pins the fix.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const signer = Keypair.generate();
const connection = {
  sendRawTransaction: jest.fn().mockResolvedValue("SIG_1"),
  confirmTransaction: jest.fn(),
  simulateTransaction: jest.fn(),
  getLatestBlockhash: jest.fn(),
};

jest.mock("../services/solana.service.js", () => ({
  __esModule: true,
  getConnection: () => connection,
  loadKeypairFromEnv: () => signer,
}));

import jupiterService from "../services/jupiter.service.js";

function unsignedSwapTxBase64(): string {
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString(
    "base64",
  );
}

const params = {
  inputMint: "TOKEN_MINT",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: "1000",
  userPublicKey: signer.publicKey.toBase58(),
  signer,
};

beforeEach(() => {
  process.env.USE_REAL_SWAP = "true";
  jest.spyOn(jupiterService, "getQuote").mockResolvedValue({
    outAmount: "5000",
  } as any);
  jest.spyOn(jupiterService as any, "buildSwapTransaction").mockResolvedValue({
    swapTransaction: unsignedSwapTxBase64(),
    lastValidBlockHeight: 100,
  });
  connection.sendRawTransaction.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("executeSwap on-chain result", () => {
  it("reports failure when the transaction confirmed but reverted", async () => {
    connection.confirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [3, { Custom: 6001 }] } },
    });
    const res = await jupiterService.executeSwap(params);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/landed but failed on-chain/);
    expect(res.error).toMatch(/6001/);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports success only when the confirmation carries no error", async () => {
    connection.confirmTransaction.mockResolvedValue({ value: { err: null } });
    const res = await jupiterService.executeSwap(params);
    expect(res.success).toBe(true);
    expect(res.signature).toBe("SIG_1");
  });

  it("reports failure when confirmation itself throws (expired blockhash)", async () => {
    connection.confirmTransaction.mockRejectedValue(
      new Error("TransactionExpiredBlockheightExceededError"),
    );
    const res = await jupiterService.executeSwap(params);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Expired/);
  });
});
