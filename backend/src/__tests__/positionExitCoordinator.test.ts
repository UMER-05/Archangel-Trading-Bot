import {
  claimPositionExit,
  completePositionExit,
  releasePositionExit,
  clearAllPositionExitClaims,
  claimedPositionExitCount,
} from "../services/execution/positionExitCoordinator.service.js";

jest.mock("../services/db.service.js", () => ({
  __esModule: true,
  default: {
    claimPositionExit: jest.fn().mockResolvedValue(true),
    renewPositionExit: jest.fn().mockResolvedValue(true),
    completePositionExit: jest.fn().mockResolvedValue(true),
    releasePositionExit: jest.fn().mockResolvedValue(true),
  },
}));

describe("position exit coordinator", () => {
  beforeEach(() => clearAllPositionExitClaims());
  afterEach(() => clearAllPositionExitClaims());

  it("allows only one sell attempt to claim a given wallet's position at a time", async () => {
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(true);
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(false);
    expect(claimedPositionExitCount()).toBe(1);
  });

  it("treats the same mint held by two different wallets as independent claims", async () => {
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(true);
    expect(await claimPositionExit("MINT_A", "WALLET_2")).toBe(true);
    expect(claimedPositionExitCount()).toBe(2);
  });

  it("clears a completed claim so a later monitor tick can claim again", async () => {
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(true);
    await completePositionExit("MINT_A", "WALLET_1");
    expect(claimedPositionExitCount()).toBe(0);
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(true);
  });

  it("releases a failed/aborted claim and permits retry", async () => {
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(true);
    await releasePositionExit("MINT_A", "WALLET_1");
    expect(claimedPositionExitCount()).toBe(0);
    expect(await claimPositionExit("MINT_A", "WALLET_1")).toBe(true);
  });
});
