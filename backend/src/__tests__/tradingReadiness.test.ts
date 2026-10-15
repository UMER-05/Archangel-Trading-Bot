import fs from "fs";
import os from "os";
import path from "path";
import { checkTradingReadiness } from "../utils/tradingReadiness.js";

const FULL_ENV = {
  SOLAMI_BLUR_API_KEY: "blur-key-value",
  JUPITER_AUTO_BUY: "true",
  USE_REAL_SWAP: "true",
  SOLANA_RPC_URL: "https://rpc.example",
  MONGO_URI: "mongodb://user:secret@host/db",
};

const byCheck = (items: ReturnType<typeof checkTradingReadiness>) =>
  Object.fromEntries(items.map((i) => [i.check, i]));

describe("checkTradingReadiness", () => {
  it("reports everything ok for a complete config", () => {
    const items = checkTradingReadiness(FULL_ENV);
    expect(items.every((i) => i.level === "ok")).toBe(true);
  });

  it("flags the gates a .env built from the old template leaves closed", () => {
    // What .env.example used to produce: wrong names for Mongo and RPC, and
    // neither the Blur key nor JUPITER_AUTO_BUY at all.
    const items = byCheck(
      checkTradingReadiness({
        MONGODB_URI: "mongodb://localhost:27017/archangel",
        RPC_URL: "https://api.mainnet-beta.solana.com",
        USE_REAL_SWAP: "false",
        RAYDIUM_AUTO_BUY: "false",
      }),
    );

    expect(items["Discovery (Blur stream)"]!.level).toBe("error");
    expect(items["Auto-buy"]!.level).toBe("error");
    expect(items["Auto-buy"]!.detail).toContain("not set");
    expect(items["Database"]!.level).toBe("error");
    expect(items["Solana RPC"]!.level).toBe("warn");
    expect(items["Swap mode"]!.level).toBe("warn");
  });

  it("treats JUPITER_AUTO_BUY values other than exactly \"true\" as off", () => {
    for (const value of ["TRUE", "1", "yes", "true "]) {
      const items = byCheck(
        checkTradingReadiness({ ...FULL_ENV, JUPITER_AUTO_BUY: value }),
      );
      expect(items["Auto-buy"]!.level).toBe("error");
    }
  });

  it("never includes secret values in its output", () => {
    const text = JSON.stringify(
      checkTradingReadiness(FULL_ENV, {
        operatorWallet: { publicKey: "OperatorPublicKey1111111111111111111111111" },
      }),
    );
    expect(text).not.toContain("blur-key-value");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("rpc.example");
  });

  it("reports which .env path was (or was not) found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-"));
    try {
      let envItem = byCheck(checkTradingReadiness(FULL_ENV, { cwd: dir }))[".env file"]!;
      expect(envItem.level).toBe("warn");
      expect(envItem.detail).toContain(path.resolve(dir, ".env"));

      fs.writeFileSync(path.join(dir, ".env"), "X=1\n");
      envItem = byCheck(checkTradingReadiness(FULL_ENV, { cwd: dir }))[".env file"]!;
      expect(envItem.level).toBe("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unusable operator wallet without failing the rest", () => {
    const items = byCheck(
      checkTradingReadiness(FULL_ENV, {
        operatorWallet: { error: "WALLET_SECRET_KEY (or WALLET_PRIVATE_KEY) missing" },
      }),
    );
    expect(items["Operator wallet"]!.level).toBe("warn");
    expect(items["Operator wallet"]!.detail).toContain("only user hot wallets");
  });
});
