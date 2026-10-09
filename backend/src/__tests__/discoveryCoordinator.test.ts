import {
  claimMint,
  completeMint,
  clearAllMints,
  claimedMintCount,
  releaseMint,
} from "../services/discoveryCoordinator.service.js";

jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    claimDiscoveryMint: jest.fn().mockResolvedValue(true),
    renewDiscoveryMint: jest.fn().mockResolvedValue(true),
    completeDiscoveryMint: jest.fn().mockResolvedValue(true),
    releaseDiscoveryMint: jest.fn().mockResolvedValue(true),
  },
}));

describe("discovery coordinator", () => {
  beforeEach(() => clearAllMints());
  afterEach(() => clearAllMints());

  it("allows only one discovery path to claim a mint", async () => {
    expect(await claimMint("MINT_A")).toBe(true);
    expect(await claimMint("MINT_A")).toBe(false);
    expect(claimedMintCount()).toBe(1);
  });

  it("tracks independent mints", async () => {
    expect(await claimMint("MINT_A")).toBe(true);
    expect(await claimMint("MINT_B")).toBe(true);
    expect(claimedMintCount()).toBe(2);
  });

  it("clears a completed local claim so later processing can claim again", async () => {
    expect(await claimMint("MINT_A")).toBe(true);
    await completeMint("MINT_A");
    expect(claimedMintCount()).toBe(0);
    expect(await claimMint("MINT_A")).toBe(true);
  });

  it("releases a failed claim and permits retry", async () => {
    expect(await claimMint("MINT_A")).toBe(true);
    await releaseMint("MINT_A");
    expect(claimedMintCount()).toBe(0);
    expect(await claimMint("MINT_A")).toBe(true);
  });
});
