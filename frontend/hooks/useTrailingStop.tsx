// hooks/useTrailingStop.tsx
"use client";

import { useEffect, useState } from "react";
import { useSocket } from "@hooks/useSocket";

export interface TrailingStopData {
  token: string;
  wallet?: string;
  currentPnlPct: number;
  highestPnlPct: number;
  trailingActivated: boolean;
  trailingStopPct: number;
  trailingActivationPct: number;
  drawdownFromPeak: number;
  timestamp: number;
}

/**
 * Hook to track trailing stop status for positions
 * Listens for position:trailingUpdate events from backend
 */
export function useTrailingStop(tokenMint?: string) {
  const { lastMessage, connected } = useSocket();
  const [trailingData, setTrailingData] = useState<TrailingStopData | null>(
    null
  );
  const [allTrailingData, setAllTrailingData] = useState<
    Map<string, TrailingStopData>
  >(new Map());

  useEffect(() => {
    if (lastMessage?.event === "position:trailingUpdate") {
      const data = lastMessage.payload as TrailingStopData;

      // Update all positions map
      setAllTrailingData((prev) => {
        const updated = new Map(prev);
        updated.set(`${data.wallet ?? ""}:${data.token}`, data);
        return updated;
      });

      // Update specific token data if it matches
      if (!tokenMint || data.token === tokenMint) {
        setTrailingData(data);
      }
    }
  }, [lastMessage, tokenMint]);

  return {
    trailingData: tokenMint ? trailingData : null,
    allTrailingData,
    connected,
    // Helper functions
    isTrailingActive: (token?: string): boolean => {
      const data = token
        ? allTrailingData.get(`${trailingData?.wallet ?? ""}:${token}`)
        : trailingData;
      return data?.trailingActivated ?? false;
    },
    getHighestPnl: (token?: string): number => {
      const data = token
        ? allTrailingData.get(`${trailingData?.wallet ?? ""}:${token}`)
        : trailingData;
      return data?.highestPnlPct ?? 0;
    },
    getDrawdown: (token?: string): number => {
      const data = token
        ? allTrailingData.get(`${trailingData?.wallet ?? ""}:${token}`)
        : trailingData;
      return data?.drawdownFromPeak ?? 0;
    },
  };
}
