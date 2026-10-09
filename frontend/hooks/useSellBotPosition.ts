// frontend/hooks/useSellBotPosition.ts
"use client";

import { useCallback, useState } from "react";
import { toast } from "react-hot-toast";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useWallet } from "./useWallet";
import { fetcher } from "@lib/utils";
import { signWalletAuth } from "@lib/walletAuth";

interface SellResponse {
  success: boolean;
  status?: "sold" | "already_closed";
  signature?: string | null;
  amountSol?: number;
  error?: string;
}

/**
 * Sells ONE position the bot holds for the connected wallet.
 *
 * Bot-bought positions live in the bot's trading wallet, which only the
 * server can sign for — so this asks the backend to sell (proving control of
 * the owner wallet with a signed message, like every other account action),
 * rather than building a transaction for the user's own wallet to sign the way
 * a manual position's sale does. "Sell All & Stop" is the sell-everything
 * version of this.
 */
export function useSellBotPosition(onDone?: () => void) {
  const { publicKey } = useWallet();
  const { signMessage } = useSolanaWallet();
  // The token currently being sold, so its button can show a spinner and
  // every other Sell button waits (one exit at a time).
  const [selling, setSelling] = useState<string | null>(null);

  const sell = useCallback(
    async (token: string, label: string): Promise<boolean> => {
      if (!publicKey) {
        toast.error("Please connect your wallet first.");
        return false;
      }
      const ok = window.confirm(
        `Sell your entire ${label} position now?\n\nThe bot sells it from its trading wallet at the current market price. This cannot be undone.`
      );
      if (!ok) return false;

      setSelling(token);
      try {
        const auth = await signWalletAuth(signMessage, publicKey);
        const res = await fetcher<SellResponse>(
          `/api/user-wallet/${publicKey}/sell-position`,
          {
            method: "POST",
            body: JSON.stringify({ token, ...auth }),
            // A sale is a real on-chain swap: quote, send, then wait for
            // confirmation. Solana confirmation alone can pass the 30s default
            // under congestion, which made a sale that was still going through
            // look like "Request timed out".
            timeoutMs: 90_000,
          }
        );
        if (!res?.success)
          throw new Error(res?.error || "Couldn't sell this position");

        if (res.status === "already_closed") {
          toast(
            "Nothing was left to sell — the stale record has been cleared."
          );
        } else {
          toast.success(
            `Sold ${label}${
              res.amountSol != null
                ? ` for ${res.amountSol.toFixed(4)} SOL`
                : ""
            }`
          );
        }
        onDone?.();
        return true;
      } catch (err: any) {
        // A timeout doesn't mean the sale failed — the server may still be
        // finishing it. Say so, and refresh, instead of leaving the row as-is.
        const timedOut = /timed out/i.test(err?.message ?? "");
        toast.error(
          timedOut
            ? "This is taking longer than usual. The sale may still complete — check your positions in a minute before trying again."
            : err?.message || "Couldn't sell this position",
          { duration: timedOut ? 8000 : 4000 }
        );
        if (timedOut) onDone?.();
        return false;
      } finally {
        setSelling(null);
      }
    },
    [publicKey, signMessage, onDone]
  );

  return { sell, selling };
}

export default useSellBotPosition;
