// components/trading/LiveTrades.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { TerminalSquare } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";

type TradeRow = {
  id: string;
  token: string;
  time: string;
  message: string;
  type: "buy" | "sell" | "info";
  pnl?: number;
  signature?: string | null;
};

export const LiveTrades: React.FC = () => {
  const { lastMessage, connected } = useSocket();
  const { publicKey } = useSolanaWallet();
  const router = useRouter();
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);

  // Clear the instant the connected wallet changes, before the backfill
  // re-fetch below even starts — otherwise the previous wallet's feed stays
  // on screen for the round-trip it takes to load the new wallet's own.
  useEffect(() => {
    setTrades([]);
  }, [publicKey]);

  // Backfill recent real trades on mount (and again on wallet change) — this
  // feed is otherwise purely socket-event-driven, so a freshly-loaded page
  // shows nothing for trades that happened before it was opened (e.g.
  // positions already held). Scoped to the connected wallet: without a
  // wallet param the backend can't tell this apart from an internal caller
  // that legitimately needs everything, and would return every wallet's
  // manual trades mixed together.
  useEffect(() => {
    let mounted = true;
    const walletParam = publicKey
      ? `&wallet=${encodeURIComponent(publicKey.toString())}`
      : "";
    (async () => {
      try {
        const res = await fetcher<{ success: boolean; trades: any[] }>(
          `/api/trade/history?limit=50${walletParam}`
        );
        if (!mounted || !res?.success || !Array.isArray(res.trades)) return;
        // No need to clear here — the dedicated effect above already
        // cleared trades the instant publicKey changed.
        const rows: TradeRow[] = res.trades.map((t) => ({
          id: t.id,
          token: t.token ?? "",
          time: new Date(t.timestamp).toLocaleTimeString("en-GB", {
            hour12: false,
          }),
          message: `${(t.type ?? "info").toUpperCase()} ${t.token ?? ""}`,
          type: t.type ?? "info",
          pnl: typeof t.pnl === "number" ? t.pnl : undefined,
          signature: t.signature ?? null,
        }));
        // Merge rather than replace — a live tradeFeed event may have already
        // arrived (and been prepended) while this fetch was in flight.
        setTrades((prev) => {
          const existingIds = new Set(prev.map((r) => r.id));
          return [...prev, ...rows.filter((r) => !existingIds.has(r.id))].slice(
            0,
            200
          );
        });
      } catch (err) {
        console.error("❌ Failed to backfill live trades:", err);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [publicKey]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event !== "tradeFeed") return;

    const t = lastMessage.payload;
    const now = new Date().toLocaleTimeString("en-GB", { hour12: false });

    // Build enhanced message with tranche/tier info
    let message =
      t.message ?? `${(t.type ?? "info").toUpperCase()} ${t.token ?? ""}`;

    // Add tranche info for 2-tranche buys
    if (t.tranche) {
      message = `${t.type?.toUpperCase()} ${t.tranche} - ${t.token ?? ""}`;
    }

    // Add tier info for tiered profit exits
    if (
      t.reason === "tiered_profit" &&
      t.sellPercent &&
      t.remainingPct !== undefined
    ) {
      message = `SELL ${t.sellPercent}% (${
        t.exitReason || "Profit Target"
      }) - ${t.remainingPct}% remaining`;
    }

    // Add emergency exit warning
    if (t.emergency || t.reason === "emergency_exit") {
      message = `🚨 EMERGENCY EXIT: ${t.exitReason || "Critical trigger"}`;
    }

    // Add trailing stop info
    if (t.reason === "trailing_stop_final") {
      message = `SELL (Trailing Stop - Final 10%) - ${t.exitReason || ""}`;
    }

    const row: TradeRow = {
      id: t.id ?? crypto.randomUUID(),
      token: t.token ?? "",
      time: now,
      message,
      type: t.emergency ? "sell" : t.type ?? "info",
      pnl: typeof t.pnl === "number" ? t.pnl : undefined,
      signature: t.signature ?? null,
    };

    setTrades((prev) => [row, ...prev].slice(0, 200));
  }, [lastMessage]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = 0;
  }, [trades]);

  return (
    <div
      className="bg-base-200 rounded-xl p-4 h-80 overflow-y-auto scrollbar-thin"
      ref={feedRef}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <TerminalSquare size={18} /> Live Trades
        </h2>
        <div className="text-xs text-gray-400">
          {connected ? "Live" : "Offline"}
        </div>
      </div>

      <ul className="space-y-2 text-sm font-mono">
        <AnimatePresence>
          {trades.map((t) => (
            <motion.li
              key={t.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              onClick={() => t.token && router.push(`/trading/${t.token}`)}
              title={t.token ? "View full token details" : undefined}
              className={`p-2 rounded ${t.token ? "cursor-pointer" : ""} ${
                t.message.includes("🚨 EMERGENCY")
                  ? "bg-red-900/40 text-red-300 border border-red-500/50 font-bold"
                  : t.type === "buy"
                  ? "bg-green-900/20 text-green-400 hover:bg-green-900/30"
                  : t.type === "sell"
                  ? "bg-red-900/20 text-red-400 hover:bg-red-900/30"
                  : "bg-slate-800/30 text-slate-300"
              }`}
            >
              <div className="flex justify-between">
                <div>
                  <span className="opacity-60">{t.time} — </span>
                  {t.message}
                </div>
                <div className="text-right">
                  {typeof t.pnl === "number" ? (
                    <span
                      className={`${
                        t.pnl >= 0 ? "text-green-400" : "text-red-400"
                      } font-semibold`}
                    >
                      {/* tradeFeed's pnl is a decimal fraction (0.4 = +40%),
                          per monitor.service.ts */}
                      {t.pnl >= 0 ? "+" : ""}
                      {(t.pnl * 100).toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
};

export default LiveTrades;
