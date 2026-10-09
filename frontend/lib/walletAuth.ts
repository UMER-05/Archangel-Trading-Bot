// frontend/lib/walletAuth.ts
//
// Client side of backend/src/utils/walletAuth.ts's proof-of-ownership check.
// Signs a short-lived message with the connected wallet so settings-changing
// requests can't be spoofed by putting a different wallet address in the URL.
// The message format here MUST match buildAuthMessage() on the backend
// exactly, or every signature will fail verification.

import bs58 from "bs58";

export type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

function buildAuthMessage(wallet: string, timestampMs: number): string {
  return `ArchAngel auth\nwallet: ${wallet}\ntimestamp: ${timestampMs}`;
}

/**
 * Signs a fresh wallet-auth message. Throws if the connected wallet doesn't
 * support message signing (most do — Phantom, Solflare, Backpack, etc.) or
 * if the user rejects the signature prompt; callers should surface that as
 * "couldn't verify wallet, please try again" rather than silently
 * proceeding without auth.
 */
export async function signWalletAuth(
  signMessage: SignMessageFn | undefined,
  wallet: string
): Promise<{ walletAuthTimestamp: number; walletAuthSignature: string }> {
  if (!signMessage) {
    throw new Error(
      "This wallet doesn't support message signing, which is required to change settings securely."
    );
  }
  const walletAuthTimestamp = Date.now();
  const message = buildAuthMessage(wallet, walletAuthTimestamp);
  const signatureBytes = await signMessage(new TextEncoder().encode(message));
  const walletAuthSignature = bs58.encode(signatureBytes);
  return { walletAuthTimestamp, walletAuthSignature };
}
