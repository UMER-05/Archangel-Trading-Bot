// frontend/hooks/useStatsSync.ts
"use client";

import { useEffect } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { toast } from "react-hot-toast";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";

/**
 * Hybrid stats sync:
 *  - Polls /api/stats every 10s
 *  - Listens for socket "stats:update"
 *  - Writes into Zustand store
 */
export const useStatsSync = () => {
  const { updateStats, setLoading } = useStats();
  const { lastMessage } = useSocket();
  const { publicKey } = useSolanaWallet();

  // Clear on-screen numbers the instant the connected wallet changes, before
  // either fetch below even starts — otherwise the previous wallet's stats/
  // trade history stay visible for the round-trip it takes to load the new
  // wallet's own (correctly-scoped, never actually leaked — just stale UI).
  // React runs effects in declaration order, so this always fires first.
  useEffect(() => {
    useStats.getState().reset();
  }, [publicKey]);

  // 0️⃣ Backfill of recent real trades, scoped to the connected wallet (bot's
  // own trades + this wallet's own — never another wallet's manual trades).
  // Re-runs on wallet change. The trade history/live feed are otherwise
  // purely socket-event-driven, so a freshly-loaded dashboard shows nothing
  // for trades/positions that happened before the page was opened.
  useEffect(() => {
    let mounted = true;
    const walletParam = publicKey
      ? `&wallet=${encodeURIComponent(publicKey.toString())}`
      : "";
    (async () => {
      try {
        const res = await fetcher<{ success: boolean; trades: any[] }>(
          `/api/trade/history?limit=100${walletParam}`
        );
        if (!mounted || !res?.success || !Array.isArray(res.trades)) return;
        // No need to clear here — the reset effect above already cleared
        // tradeHistory the instant publicKey changed, before this fetch
        // even started.
        const historical = res.trades.map((t) => ({
          id: t.id,
          type: t.type as "buy" | "sell",
          token: t.token,
          amount: t.amountLamports,
          pnl: t.pnl ?? 0,
          timestamp: new Date(t.timestamp).getTime(),
        }));
        // Merge rather than replace — a live trade may have already arrived
        // (via live-feed.tsx's addTrade) while this fetch was in flight.
        const existing = useStats.getState().tradeHistory;
        const existingIds = new Set(existing.map((t) => t.id));
        useStats
          .getState()
          .setTradeHistory([
            ...existing,
            ...historical.filter((t) => !existingIds.has(t.id)),
          ]);
      } catch (err) {
        console.error("❌ Failed to backfill trade history:", err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [publicKey]);

  // 1️⃣ Poll backend periodically — scoped to the connected wallet, same as
  // the trade-history backfill above. Without this, Portfolio Value/Total
  // Profit/Open Trades/Win Rate showed the bot's global numbers to every
  // viewer regardless of which wallet they had connected.
  useEffect(() => {
    const walletParam = publicKey
      ? `?wallet=${encodeURIComponent(publicKey.toString())}`
      : "";
    const fetchStats = async () => {
      try {
        const data = await fetcher(`/api/stats${walletParam}`);

        updateStats((prev) => ({
          portfolioValue: Number(data.portfolioValue ?? prev.portfolioValue),
          totalProfitSol: Number(data.totalProfitSol ?? prev.totalProfitSol),
          totalProfitPercent: Number(
            data.totalProfitPercent ?? prev.totalProfitPercent
          ),
          openTrades: Number(data.openTrades ?? prev.openTrades),
          tradeVolumeSol: Number(data.tradeVolumeSol ?? prev.tradeVolumeSol),
          winRate: Number(data.winRate ?? prev.winRate),
        }));
      } catch (err) {
        console.error("❌ Failed to fetch stats:", err);
        toast.error("Unable to load dashboard stats.");
      } finally {
        // Loading state must clear even on failure, otherwise the panels
        // gated on it (StatsPanel, TradeHistory) show a spinner forever.
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [updateStats, setLoading, publicKey]);

  // 2️⃣ Live updates from socket — the backend now scopes this event to only
  // the socket that identified as the same wallet it's reporting on (see
  // socket.route.ts's "identify" room join + emitToWalletOrGlobal), so
  // whatever arrives here is already this wallet's own data, safe to apply
  // regardless of connection state.
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event !== "stats:update") return;

    const s = lastMessage.payload;
    if (!s) return;

    updateStats((prev) => ({
      portfolioValue: Number(s.portfolioValue ?? prev.portfolioValue),
      totalProfitSol: Number(s.totalProfitSol ?? prev.totalProfitSol),
      totalProfitPercent: Number(
        s.totalProfitPercent ?? prev.totalProfitPercent
      ),
      openTrades: Number(s.openTrades ?? prev.openTrades),
      tradeVolumeSol: Number(s.tradeVolumeSol ?? prev.tradeVolumeSol),
      winRate: Number(s.winRate ?? prev.winRate),
    }));
  }, [lastMessage, updateStats]);
};
