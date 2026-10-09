"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
import { TerminalSquare, BarChart3 } from "lucide-react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  animate,
} from "framer-motion";
import { useSocket } from "@hooks/useSocket";

import { useTradingConfigStore } from "@hooks/useConfig";
import { useStats } from "@hooks/useStats";

interface TradeLog {
  id: string;
  time: string;
  message: string;
  type: "buy" | "sell" | "info";
  pnl?: number; // decimal: 0.02 = +2%
  amount?: number; // SOL amount
  signature?: string | null;
}

/* Animated number components */
const AnimatedNumber = ({ value }: { value: number }) => {
  const mv = useMotionValue(value);
  const display = useTransform(mv, (v) => v.toFixed(0));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.6, ease: "easeOut" });
    return () => controls.stop();
  }, [value, mv]);
  return <motion.span>{display}</motion.span>;
};

const AnimatedPercent = ({ value }: { value: number }) => {
  const mv = useMotionValue(value);
  const display = useTransform(mv, (v) => v.toFixed(2));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.6, ease: "easeOut" });
    return () => controls.stop();
  }, [value, mv]);
  return <motion.span>{display}</motion.span>;
};

export default function LiveFeed() {
  const { connected, lastMessage } = useSocket();
  const { stats, updateStats, addTrade } = useStats();
  const { selectedToken } = useTradingConfigStore();

  const [logs, setLogs] = useState<TradeLog[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll
  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [logs]);

  // Handle incoming socket trading and onchain events
  useEffect(() => {
    if (!lastMessage) return;

    const { event, payload } = lastMessage;
    const now = new Date().toLocaleTimeString("en-GB", { hour12: false });

    // Trading events (existing logic)
    if (["tradeFeed", "tradeLog", "trade:update"].includes(event)) {
      const type =
        payload?.type === "buy" || payload?.type === "sell"
          ? payload.type
          : "info";

      // Build enhanced message
      let message = payload?.message ?? `${type.toUpperCase()} executed`;

      // Tranche buy messages
      if (payload?.tranche) {
        message = `${type.toUpperCase()} ${payload.tranche}`;
      }

      // Tiered profit messages
      if (payload?.reason === "tiered_profit") {
        message = `SELL ${payload.sellPercent}% at ${payload.exitReason} (${payload.remainingPct}% left)`;
      }

      // Emergency exit messages
      if (payload?.emergency || payload?.reason === "emergency_exit") {
        message = `🚨 EMERGENCY: ${payload.exitReason || "Critical exit"}`;
      }

      // Trailing stop final
      if (payload?.reason === "trailing_stop_final") {
        message = `Trailing Stop (Final 10%): ${payload.exitReason || ""}`;
      }

      if (payload?.reason === "take_profit") {
        message = `SELL Take profit (${((payload.pnl ?? 0) * 100).toFixed(2)}%)`;
      }

      if (payload?.reason === "stop_loss") {
        message = `SELL Stop loss (${((payload.pnl ?? 0) * 100).toFixed(2)}%)`;
      }

      if (payload?.reason === "partial_buy") {
        message = `BUY Partial position: ${payload.tranche || "first tranche"}`;
      }

      const incoming: TradeLog = {
        id: crypto.randomUUID(),
        time: now,
        message,
        type: payload?.emergency ? "sell" : type,
        pnl: typeof payload?.pnl === "number" ? payload.pnl : undefined,
        amount: payload?.amount ?? 0,
        signature: payload?.signature ?? null,
      };

      setLogs((prev) => [...prev.slice(-299), incoming]);

      // Also feed the shared store so TradeHistory (a separate component
      // reading the same useStats() state) reflects live trades too.
      if (
        (type === "buy" || type === "sell") &&
        payload?.reason !== "partial_buy"
      ) {
        addTrade({
          id: incoming.id,
          type,
          token: payload?.token ?? payload?.mint ?? "",
          amount: payload?.amount ?? payload?.amountLamports ?? 0,
          pnl: typeof payload?.pnl === "number" ? payload.pnl : 0,
          timestamp: Date.now(),
        });
      }

      if (typeof incoming.pnl === "number") {
        // incoming.amount arrives in lamports (backend emits tradeFeed with
        // amount = amountSol * 1e9) — totalProfitSol/tradeVolumeSol are SOL-
        // denominated (see useStatsSync, which syncs the same field names
        // straight from /api/stats), so it must be converted here or these
        // optimistic updates spike ~1e9x until the next poll overwrites them.
        const amountSol = (incoming.amount ?? 0) / 1e9;
        const profitSol = amountSol * incoming.pnl;

        // totalProfitPercent is NOT touched here — it's a portfolio-wide
        // ratio (totalProfitSol / tradeVolumeSol, db.service.ts), not a sum
        // of each trade's own pnl%. Summing individual trade percents here
        // used a different formula from the authoritative one and could
        // drift arbitrarily far from it before the next useStatsSync poll
        // overwrote it.
        updateStats((prev) => ({
          totalProfitSol: prev.totalProfitSol + profitSol,
          tradeVolumeSol: prev.tradeVolumeSol + amountSol,
        }));
      }
      return;
    }
  }, [lastMessage, stats, updateStats, addTrade]);

  // Offline heartbeat
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(() => {
      const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
      setLogs((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          time: now,
          message: "Awaiting live trading feed...",
          type: "info",
        },
      ]);
    }, 8000);
    return () => clearInterval(timer);
  }, [connected]);

  const summary = useMemo(() => {
    const trades = logs.filter((l) => typeof l.pnl === "number");
    const pnlVals = trades.map((l) => l.pnl ?? 0);
    return {
      buys: logs.filter((l) => l.type === "buy").length,
      sells: logs.filter((l) => l.type === "sell").length,
      totalProfit: pnlVals.reduce((a, b) => a + b, 0) * 100,
      winRate:
        pnlVals.length > 0
          ? (pnlVals.filter((p) => p > 0).length / pnlVals.length) * 100
          : 0,
    };
  }, [logs]);

  const glowColor =
    summary.totalProfit > 0
      ? "rgba(34,197,94,0.3)"
      : summary.totalProfit < 0
        ? "rgba(239,68,68,0.3)"
        : "rgba(148,163,184,0.15)";

  return (
    <div className="bg-base-200 rounded-xl p-4 h-[26rem] flex flex-col border border-base-300 shadow-lg relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <TerminalSquare size={18} /> Live Feed — {selectedToken ?? "ALL"}
        </h2>
        <span
          className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}
        >
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Log feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto pr-2 space-y-2 text-sm font-mono scrollbar-thin"
      >
        <AnimatePresence>
          {logs.map((log) => (
            <motion.div
              key={log.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25 }}
              className={`p-2 rounded ${
                log.type === "buy"
                  ? "bg-green-900/30 text-green-400"
                  : log.type === "sell"
                    ? "bg-red-900/30 text-red-400"
                    : "bg-slate-800/30 text-slate-300"
              }`}
            >
              <div className="flex justify-between items-center">
                <div>
                  <span className="opacity-60">{log.time} — </span>
                  {log.message}
                </div>
                {typeof log.pnl === "number" && (
                  <span className="font-bold">
                    {(log.pnl * 100).toFixed(2)}%
                  </span>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Summary */}
      <motion.div
        animate={{ boxShadow: `0 0 12px ${glowColor}` }}
        transition={{ duration: 0.6 }}
        className="border-t border-base-300 mt-3 pt-3 px-2 flex justify-between text-xs font-mono"
      >
        <span className="text-green-400">
          Buys: <AnimatedNumber value={summary.buys} />
        </span>
        <span className="text-red-400">
          Sells: <AnimatedNumber value={summary.sells} />
        </span>
        <span>
          Win Rate: <AnimatedPercent value={summary.winRate} />%
        </span>
        <span
          className={`${
            summary.totalProfit >= 0 ? "text-green-400" : "text-red-400"
          }`}
        >
          P/L: <AnimatedPercent value={summary.totalProfit} />%
        </span>
      </motion.div>
    </div>
  );
}
