import { verifyRaydiumPool } from "../services/execution/poolVerification.service.js";
import { RAYDIUM_PROGRAM_IDS } from "../services/execution/raydiumProgramIds.js";

const getAccountInfoMock = jest.fn();

jest.mock("../services/solana.service.js", () => ({
  __esModule: true,
  getConnection: () => ({
    getAccountInfo: getAccountInfoMock,
  }),
}));

// A syntactically valid base58 Solana public key, distinct from any real
// program ID, used purely as a stand-in poolAddress in these tests.
const FAKE_POOL_ADDRESS = "11111111111111111111111111111112";

describe("verifyRaydiumPool", () => {
  beforeEach(() => {
    getAccountInfoMock.mockReset();
  });

  it("rejects an unrecognized dex string before touching the RPC", async () => {
    const result = await verifyRaydiumPool("orca-whirlpool", FAKE_POOL_ADDRESS);
    expect(result.verified).toBe(false);
    expect(result.poolType).toBeNull();
    expect(getAccountInfoMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed poolAddress", async () => {
    const result = await verifyRaydiumPool(
      "raydium-cpmm",
      "not-a-real-address",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/base58/i);
  });

  it("rejects when the pool account does not exist on-chain", async () => {
    getAccountInfoMock.mockResolvedValue(null);
    const result = await verifyRaydiumPool("raydium-cpmm", FAKE_POOL_ADDRESS);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/does not exist/i);
  });

  it("rejects when the on-chain owner doesn't match the claimed pool type's pinned program", async () => {
    getAccountInfoMock.mockResolvedValue({
      owner: { toBase58: () => "SomeOtherProgram11111111111111111111111111" },
      data: Buffer.from([1, 2, 3]),
    });
    const result = await verifyRaydiumPool("raydium-cpmm", FAKE_POOL_ADDRESS);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/owner mismatch/i);
  });

  it("verifies when the on-chain owner matches the pinned program for the claimed type", async () => {
    getAccountInfoMock.mockResolvedValue({
      owner: { toBase58: () => RAYDIUM_PROGRAM_IDS["raydium-cpmm"] },
      data: Buffer.from([1, 2, 3]),
    });
    const result = await verifyRaydiumPool("raydium-cpmm", FAKE_POOL_ADDRESS);
    expect(result.verified).toBe(true);
    expect(result.poolType).toBe("raydium-cpmm");
  });
});
