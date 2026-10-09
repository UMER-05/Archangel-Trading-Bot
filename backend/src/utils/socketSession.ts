// backend/src/utils/socketSession.ts
//
// Short-lived, wallet-bound session tokens for the socket "identify"
// handshake. Proving control of a wallet takes a wallet signature (a popup in
// the user's wallet); doing that on every reconnect would be miserable, so the
// FIRST identify is verified by signature (utils/walletAuth.ts) and the server
// hands back one of these tokens, which the client presents on later
// reconnects instead.
//
//   token = "<expiresAtMs>.<hex hmac-sha256(secret, wallet|expiresAtMs)>"
//
// It can't be moved to another wallet (the wallet is part of what's signed),
// can't be extended (so is the expiry), and can't be forged without the
// secret. Set SOCKET_SESSION_SECRET to keep tokens valid across restarts; if
// it's unset a random per-process secret is used, so a restart just makes each
// client sign once more.
import crypto from "crypto";

const PROCESS_SECRET =
  process.env.SOCKET_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

export const SOCKET_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sign(secret: string, wallet: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${wallet}|${expiresAt}`)
    .digest("hex");
}

export function issueSocketToken(
  wallet: string,
  now: number = Date.now(),
  opts: { ttlMs?: number; secret?: string } = {},
): { token: string; expiresAt: number } {
  const expiresAt = now + (opts.ttlMs ?? SOCKET_SESSION_TTL_MS);
  const mac = sign(opts.secret ?? PROCESS_SECRET, wallet, expiresAt);
  return { token: `${expiresAt}.${mac}`, expiresAt };
}

export function verifySocketToken(
  wallet: string,
  token: unknown,
  now: number = Date.now(),
  opts: { secret?: string } = {},
): boolean {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const expiresAt = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const expected = sign(opts.secret ?? PROCESS_SECRET, wallet, expiresAt);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
