// frontend/hooks/usePnLData.ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { fetcher } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";

export interface PortfolioPnL {
  totalInvestedSol: number;
  totalReturnedSol: number;
  unrealizedPnlSol: number;
  realizedPnlSol: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  winningTrades: number;
  losingTrades: number;
  totalTrades: number;
  winRate: number;
  averageWinSol: number;
  averageLossSol: number;
  largestWinSol: number;
  largestLossSol: number;
  openPositionsValue: number;
  closedPositionsValue: number;
  roi: number;
  // Total SOL ever deposited into this wallet's custodial trading wallet,
  // and that total plus net PnL (= Portfolio Value shown elsewhere on the
  // dashboard). See backend/src/services/portfolioValuation.service.ts.
  totalDepositedSol: number;
  portfolioValue: number;
}

export interface TokenPnL {
  token: string;
  symbol?: string;
  totalBought: number;
  totalSold: number;
  remainingTokens: number;
  averageBuyPrice: number;
  currentValue?: number;
  pnlSol: number;
  pnlPercent: number;
  trades: number;
  status: "open" | "closed";
}

export interface PnLHistoryPoint {
  date: string;
  realizedPnlSol: number;
  tradeCount: number;
  winRate: number;
}

const POLL_MS = 30000; // matches pnlBroadcaster.service.ts's own interval

export function usePnLData(historyDays = 30) {
  const { lastMessage, connected, sendMessage } = useSocket();
  const { publicKey } = useSolanaWallet();
  const [portfolio, setPortfolio] = useState<PortfolioPnL | null>(null);
  const [tokenPnL, setTokenPnL] = useState<TokenPnL[]>([]);
  const [history, setHistory] = useState<PnLHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Clear the instant the connected wallet changes, before the re-fetch
  // below even starts — otherwise the previous wallet's P&L stays on
  // screen for the round-trip it takes to load the new wallet's own.
  useEffect(() => {
    setPortfolio(null);
    setTokenPnL([]);
    setHistory([]);
    setLoading(true);
  }, [publicKey]);

  const load = useCallback(async () => {
    try {
      // Scoped to the connected wallet — the bot's own P&L plus this
      // wallet's own, never another wallet's (see pnl.route.ts).
      const wallet = publicKey ? encodeURIComponent(publicKey.toString()) : "";
      const [portfolioRes, tokensRes, historyRes] = await Promise.all([
        fetcher(`/api/pnl/portfolio${wallet ? `?wallet=${wallet}` : ""}`),
        fetcher(`/api/pnl/tokens${wallet ? `?wallet=${wallet}` : ""}`),
        fetcher(
          `/api/pnl/history?days=${historyDays}${wallet ? `&wallet=${wallet}` : ""}`
        ),
      ]);
      if (portfolioRes?.success) setPortfolio(portfolioRes.data);
      if (tokensRes?.success) setTokenPnL(tokensRes.data || []);
      if (historyRes?.success) setHistory(historyRes.data || []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Failed to load P&L data");
    } finally {
      setLoading(false);
    }
  }, [historyDays, publicKey]);

  // Initial load + periodic refresh (covers getPnLHistory, which has no
  // real-time socket push — it's a daily aggregate, not worth pushing live)
  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Live updates without waiting for the next poll tick. The backend now
  // scopes both broadcasts to only the socket that identified as the same
  // wallet they report on (see socket.route.ts's "identify" room join +
  // emitToWalletOrGlobal), so whatever arrives here is already this
  // wallet's own data, safe to apply regardless of connection state.
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "portfolio:pnl:update") {
      setPortfolio(lastMessage.payload);
    }
    if (lastMessage.event === "pnl:tokens:update") {
      setTokenPnL(lastMessage.payload || []);
    }
  }, [lastMessage]);

  useEffect(() => {
    if (connected) sendMessage("pnl:tokens:request");
  }, [connected, sendMessage]);

  return { portfolio, tokenPnL, history, loading, error, refresh: load };
}

export default usePnLData;
