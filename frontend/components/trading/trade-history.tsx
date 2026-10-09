//components/trading/trade-history.tsx
"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { formatTime } from "@lib/utils";
import { useStats } from "@hooks/useStats";

export default function TradeHistory() {
  const { tradeHistory, loading } = useStats();

  if (loading) {
    return (
      <div className="p-4 text-gray-400 text-sm italic">
        Loading trade history...
      </div>
    );
  }

  if (!tradeHistory.length) {
    return (
      <div className="p-4 text-gray-400 text-sm italic">
        No trades yet. Execute a trade to see live updates!
      </div>
    );
  }

  return (
    <div className="bg-base-200 border border-base-300 rounded-xl overflow-hidden shadow-lg">
      <div className="px-4 py-3 border-b border-base-300 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-primary uppercase tracking-wide">
          Trade History
        </h2>
        <span className="text-xs text-gray-500">
          {tradeHistory.length} total
        </span>
      </div>

      <div className="h-[16rem] overflow-y-auto scrollbar-thin">
        <AnimatePresence>
          {tradeHistory.map((trade) => (
            <motion.div
              key={trade.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3 }}
              className={`flex justify-between items-center px-4 py-2 text-xs border-b border-base-300 ${
                trade.type === "buy"
                  ? "bg-green-900/10 text-green-400"
                  : "bg-red-900/10 text-red-400"
              }`}
            >
              <div className="flex flex-col">
                <span className="font-semibold">
                  {trade.type.toUpperCase()} {trade.token || "TOKEN"}
                </span>
                <span className="text-[10px] text-gray-400">
                  {formatTime(new Date(trade.timestamp))}
                </span>
              </div>

              <div className="text-right font-mono">
                <p>{(trade.amount / 1e9).toFixed(4)} SOL</p>
                <p
                  className={`text-[10px] ${
                    trade.pnl >= 0 ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {trade.pnl >= 0 ? "+" : ""}
                  {(trade.pnl * 100).toFixed(2)}%
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
