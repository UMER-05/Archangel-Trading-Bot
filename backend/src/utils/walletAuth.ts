// backend/src/utils/walletAuth.ts
//
// Verifies that a request claiming to act as wallet X was actually
// authorized by whoever controls wallet X's private key — via a message
// signed client-side through the connected wallet (Phantom/Solflare's
// signMessage), never a private key touching the backend. This is what
// prevents a request from just changing a `wallet` field in the body/URL
// and acting as someone else's identity.
//
// The expected message is built here from {wallet, timestamp} rather than
// trusted from the client, so there's nothing to parse/validate about its
// format — a client can't forge verification by sending an oddly-shaped
// message string, since the signature has to match the exact string this
// function reconstructs.
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { getLogger } from "./logger.js";
import { normalizeWalletAddress } from "../services/solana.service.js";

const log = getLogger("walletAuth");

// How long a signed message stays valid for — bounds the replay window if a
// signature were ever intercepted. Short enough to matter, long enough that
// clock drift/network latency don't routinely break legitimate requests.
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

// Must match frontend/lib/walletAuth.ts's buildAuthMessage() byte-for-byte —
// this is the exact string whose signature gets verified, so any divergence
// (even whitespace) makes every signature fail.
export function buildAuthMessage(wallet: string, timestamp: number | string): string {
  return `ArchAngel auth\nwallet: ${wallet}\ntimestamp: ${timestamp}`;
}

export interface WalletAuthInput {
  wallet: string | undefined;
  timestamp: string | number | undefined;
  signature: string | undefined;
}

/**
 * Verifies { wallet, timestamp, signature } proves control of `wallet` right
 * now. Returns the normalized wallet address on success, null on any
 * failure (bad shape, expired timestamp, bad signature) — logs the specific
 * reason but never throws, so call sites can treat this as a simple gate.
 */
export function verifyWalletAuth(input: WalletAuthInput): string | null {
  if (!input?.wallet || !input?.timestamp || !input?.signature) {
    log.warn("Wallet auth rejected: missing wallet/timestamp/signature");
    return null;
  }

  let wallet: string;
  try {
    wallet = normalizeWalletAddress(input.wallet);
  } catch {
    log.warn({ wallet: input.wallet }, "Wallet auth rejected: invalid wallet address");
    return null;
  }

  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_MESSAGE_AGE_MS) {
    log.warn({ wallet, timestamp: input.timestamp }, "Wallet auth rejected: expired or invalid timestamp");
    return null;
  }

  const message = buildAuthMessage(wallet, timestampMs);

  let signatureBytes: Uint8Array;
  let pubkeyBytes: Uint8Array;
  try {
    signatureBytes = bs58.decode(input.signature);
    pubkeyBytes = new PublicKey(wallet).toBytes();
  } catch {
    log.warn({ wallet }, "Wallet auth rejected: malformed signature");
    return null;
  }

  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    signatureBytes,
    pubkeyBytes
  );

  if (!verified) {
    log.warn({ wallet }, "Wallet auth rejected: signature verification failed");
    return null;
  }

  return wallet;
}
