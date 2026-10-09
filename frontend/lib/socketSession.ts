// frontend/lib/socketSession.ts
//
// Remembers the session token the server hands back after a wallet-signed
// socket "identify" (backend src/utils/socketSession.ts). With it, a
// reconnect — or a page reload in the same tab — re-identifies without
// popping the wallet again; without it, the user would be asked to sign on
// every reconnect. Kept per wallet in sessionStorage: it dies with the tab
// and is never shared between browser profiles.

export interface StoredSocketToken {
  token: string;
  expiresAt: number;
}

type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "archangel:socketToken:";
// Treat a token this close to expiry as already expired, so a reconnect
// doesn't race the server's clock and fail.
const EXPIRY_MARGIN_MS = 60_000;

function defaultStorage(): TokenStorage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null; // storage blocked (private mode, disabled cookies...)
  }
}

export function readSocketToken(
  wallet: string,
  now: number = Date.now(),
  storage: TokenStorage | null = defaultStorage()
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY_PREFIX + wallet);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSocketToken>;
    if (
      typeof parsed?.token !== "string" ||
      typeof parsed?.expiresAt !== "number" ||
      parsed.expiresAt - EXPIRY_MARGIN_MS <= now
    ) {
      storage.removeItem(KEY_PREFIX + wallet);
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

export function writeSocketToken(
  wallet: string,
  token: string,
  expiresAt: number,
  storage: TokenStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(
      KEY_PREFIX + wallet,
      JSON.stringify({ token, expiresAt } satisfies StoredSocketToken)
    );
  } catch {
    // Storage full/blocked: identify just needs a signature next time.
  }
}

export function clearSocketToken(
  wallet: string,
  storage: TokenStorage | null = defaultStorage()
): void {
  try {
    storage?.removeItem(KEY_PREFIX + wallet);
  } catch {
    // nothing to do
  }
}
