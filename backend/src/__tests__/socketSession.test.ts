import { issueSocketToken, verifySocketToken } from "../utils/socketSession.js";

const WALLET = "3anGwPyeLe5k9kWjqkPPRtZFve7KQv1Td1aJcZ9qAAXE";
const OTHER = "75iLdZ4G3BjPWDVcBi6QaGkSFvfSzqUGkZqtgUHY1Ab5";
const opts = { secret: "test-secret" };

describe("socket session tokens", () => {
  it("accepts a token it issued for the same wallet", () => {
    const { token } = issueSocketToken(WALLET, 1000, opts);
    expect(verifySocketToken(WALLET, token, 2000, opts)).toBe(true);
  });

  it("rejects the token for a different wallet", () => {
    const { token } = issueSocketToken(WALLET, 1000, opts);
    expect(verifySocketToken(OTHER, token, 2000, opts)).toBe(false);
  });

  it("rejects an expired token", () => {
    const { token, expiresAt } = issueSocketToken(WALLET, 1000, {
      ...opts,
      ttlMs: 500,
    });
    expect(verifySocketToken(WALLET, token, expiresAt - 1, opts)).toBe(true);
    expect(verifySocketToken(WALLET, token, expiresAt, opts)).toBe(false);
  });

  it("rejects a token whose expiry was extended", () => {
    const { token } = issueSocketToken(WALLET, 1000, { ...opts, ttlMs: 500 });
    const mac = token.slice(token.indexOf(".") + 1);
    expect(verifySocketToken(WALLET, `999999999999.${mac}`, 2000, opts)).toBe(
      false,
    );
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = issueSocketToken(WALLET, 1000, {
      secret: "other-secret",
    });
    expect(verifySocketToken(WALLET, token, 2000, opts)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "nodot",
      ".abc",
      "abc.",
      "12.zz",
      {},
    ]) {
      expect(verifySocketToken(WALLET, bad, 2000, opts)).toBe(false);
    }
  });
});
