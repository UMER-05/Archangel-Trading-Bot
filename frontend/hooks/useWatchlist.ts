// frontend/hooks/useWatchlist.ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetcher } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";
import { useWallet } from "@hooks/useWallet";

export interface WatchlistPriceAlert {
  targetPrice: number;
  condition: "above" | "below";
  triggered?: boolean;
}

export interface WatchlistToken {
  _id?: string;
  mint: string;
  symbol?: string;
  name?: string;
  addedAt: string;
  userId?: string;
  priceAlert?: WatchlistPriceAlert;
  notes?: string;
}

// Each connected wallet has its OWN watchlist: every request carries the wallet
// as `userId`. Without it the list was one shared table for all visitors —
// anyone could see, change or delete anyone else's tokens and price alerts.
export function useWatchlist() {
  const [tokens, setTokens] = useState<WatchlistToken[]>([]);
  const [loading, setLoading] = useState(true);
  const { lastMessage } = useSocket();
  const { publicKey: wallet } = useWallet();

  const load = useCallback(async () => {
    if (!wallet) {
      setTokens([]);
      setLoading(false);
      return;
    }
    try {
      const res = await fetcher<{ success: boolean; tokens: WatchlistToken[] }>(
        `/api/watchlist?userId=${encodeURIComponent(wallet)}`
      );
      if (res?.success) setTokens(res.tokens || []);
    } catch (err) {
      console.warn("Failed to load watchlist:", err);
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    // Drop the previous wallet's list the moment the wallet changes.
    setTokens([]);
    setLoading(true);
    load();
  }, [load]);

  // Real-time sync — watchlist.route.ts broadcasts watchlist:update after
  // every add/remove so every open tab stays in sync without polling.
  useEffect(() => {
    if (lastMessage?.event === "watchlist:update") {
      setTokens(lastMessage.payload || []);
    }
    // Setting an alert only broadcasts priceAlert:set, not a fresh list —
    // re-fetch so other tabs pick up the new alert too.
    if (lastMessage?.event === "priceAlert:set") {
      load();
    }
  }, [lastMessage, load]);

  const addToken = useCallback(
    async (mint: string, symbol?: string, name?: string) => {
      const res = await fetcher<{ success: boolean; error?: string }>(
        "/api/watchlist",
        {
          method: "POST",
          body: JSON.stringify({ mint, symbol, name, userId: wallet }),
        }
      );
      if (res?.success) await load();
      return res;
    },
    [load, wallet]
  );

  const removeToken = useCallback(
    async (mint: string) => {
      const res = await fetcher<{ success: boolean }>(
        `/api/watchlist/${mint}?userId=${encodeURIComponent(wallet ?? "")}`,
        { method: "DELETE" }
      );
      if (res?.success) await load();
      return res;
    },
    [load, wallet]
  );

  const setPriceAlert = useCallback(
    async (mint: string, targetPrice: number, condition: "above" | "below") => {
      const res = await fetcher<{ success: boolean }>(
        `/api/watchlist/${mint}/alert?userId=${encodeURIComponent(wallet ?? "")}`,
        {
          method: "PATCH",
          body: JSON.stringify({ targetPrice, condition }),
        }
      );
      if (res?.success) await load();
      return res;
    },
    [load, wallet]
  );

  return {
    tokens,
    loading,
    connected: !!wallet,
    addToken,
    removeToken,
    setPriceAlert,
    refresh: load,
  };
}

export default useWatchlist;
