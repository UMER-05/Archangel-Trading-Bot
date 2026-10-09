"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./useSocket";

export interface PnLUpdate {
  tokenMint: string;
  wallet: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  unrealizedPnL: number;
  percentChange: number;
  priceImpact: number;
  liquidityMovement: number;
  trendDirection: "up" | "down" | "stable";
  timestamp: number;
}

// Live per-position P&L (the backend's "pnl:update" events).
//
// This hook used to ALSO track jupiter:token_detected / token_skipped /
// validation_passed / validation_failed / pipeline_failed / pipeline_success.
// The backend hasn't emitted any of those since discovery moved to the Blur
// stream, so they were always empty; the discovery feed now uses
// hooks/useCandidateEvents.ts.
export function useJupiterEvents() {
  const { lastMessage, connected } = useSocket();
  const [pnlUpdates, setPnlUpdates] = useState<Map<string, PnLUpdate>>(
    new Map()
  );

  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.event === "pnl:update") {
      setPnlUpdates((prev) => {
        const updated = new Map(prev);
        const key = `${lastMessage.payload.wallet ?? ""}:${lastMessage.payload.tokenMint}`;
        updated.set(key, lastMessage.payload);
        return updated;
      });
    }
  }, [lastMessage]);

  return { connected, pnlUpdates };
}
