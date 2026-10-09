import { PublicKey } from "@solana/web3.js";
import {
  RAYDIUM_PROGRAM_IDS,
  toCanonicalRaydiumPoolType,
} from "../services/execution/raydiumProgramIds.js";

describe("RAYDIUM_PROGRAM_IDS", () => {
  // Catches exactly the class of bug this was written after finding: a
  // pinned program ID string missing a trailing character. PublicKey's
  // constructor validates that the decoded bytes are exactly 32 long —
  // a 43-vs-44-character base58 string decodes to the wrong byte length
  // and throws here, rather than silently compiling and then failing
  // every on-chain owner comparison at runtime.
  it("every pinned program ID is a structurally valid 32-byte public key", () => {
    for (const [poolType, id] of Object.entries(RAYDIUM_PROGRAM_IDS)) {
      expect(() => new PublicKey(id)).not.toThrow();
      expect(new PublicKey(id).toBase58()).toBe(id);
    }
  });

  it("toCanonicalRaydiumPoolType maps every pinned type's own key back to itself", () => {
    for (const poolType of Object.keys(RAYDIUM_PROGRAM_IDS)) {
      expect(toCanonicalRaydiumPoolType(poolType)).toBe(poolType);
    }
  });
});
