import { describe, it, expect } from "vitest";
import {
  clearSocketToken,
  readSocketToken,
  writeSocketToken,
} from "../socketSession";

const WALLET = "3anGwPyeLe5k9kWjqkPPRtZFve7KQv1Td1aJcZ9qAAXE";
const OTHER = "75iLdZ4G3BjPWDVcBi6QaGkSFvfSzqUGkZqtgUHY1Ab5";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

describe("socket session token storage", () => {
  it("returns a stored token until shortly before it expires", () => {
    const s = fakeStorage();
    writeSocketToken(WALLET, "tok", 10_000_000, s);
    expect(readSocketToken(WALLET, 1_000, s)).toBe("tok");
    // inside the 60s safety margin counts as expired
    expect(readSocketToken(WALLET, 10_000_000 - 30_000, s)).toBeNull();
  });

  it("keeps tokens per wallet", () => {
    const s = fakeStorage();
    writeSocketToken(WALLET, "a", 10_000_000, s);
    expect(readSocketToken(OTHER, 1_000, s)).toBeNull();
  });

  it("forgets a token on request", () => {
    const s = fakeStorage();
    writeSocketToken(WALLET, "tok", 10_000_000, s);
    clearSocketToken(WALLET, s);
    expect(readSocketToken(WALLET, 1_000, s)).toBeNull();
  });

  it("drops an expired token from storage when it is read", () => {
    const s = fakeStorage();
    writeSocketToken(WALLET, "tok", 5_000, s);
    expect(readSocketToken(WALLET, 999_999, s)).toBeNull();
    expect(s.raw.size).toBe(0);
  });

  it("survives corrupt stored data and missing storage", () => {
    const s = fakeStorage();
    s.setItem("archangel:socketToken:" + WALLET, "{not json");
    expect(readSocketToken(WALLET, 1_000, s)).toBeNull();
    expect(readSocketToken(WALLET, 1_000, null)).toBeNull();
    expect(() => writeSocketToken(WALLET, "t", 1, null)).not.toThrow();
    expect(() => clearSocketToken(WALLET, null)).not.toThrow();
  });
});
