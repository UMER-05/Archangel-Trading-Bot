// frontend/app/trading/stats-panel.tsx
"use client";

import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { TrendingUp, Wallet, Activity } from "lucide-react";
import { useStats } from "@hooks/useStats";
import { useWallet } from "@hooks/useWallet";
import { formatNumber } from "@lib/utils";

export default function StatsPanel() {
  const { stats, loading } = useStats();
  const { connected, balance } = useWallet();

  if (loading) {
    return (
      <Card className="bg-base-200 p-4 text-center text-gray-400">
        Loading stats…
      </Card>
    );
  }

  const pnlPositive = stats.totalProfitSol >= 0;

  return (
    <Card className="bg-base-200 rounded-xl p-4 shadow">
      <CardHeader>
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Activity size={18} /> Trading Stats
        </CardTitle>
      </CardHeader>

      <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center text-sm">
        {/* TOTAL PROFIT */}
        <div>
          <p className="opacity-60 text-xs">Total Profit</p>
          <div
            className={`font-bold ${
              pnlPositive ? "text-green-400" : "text-red-400"
            }`}
          >
            {pnlPositive ? "+" : ""}
            {stats.totalProfitSol.toFixed(4)} SOL
            <span className="text-xs opacity-70 ml-1">
              {/* db.service.ts sends this as a decimal ratio
                  (totalProfitSol / tradeVolumeSol), not a whole-number percent */}
              ({pnlPositive ? "+" : ""}
              {(stats.totalProfitPercent * 100).toFixed(2)}%)
            </span>
          </div>
        </div>

        {/* OPEN TRADES */}
        <div>
          <p className="opacity-60 text-xs">Open Trades</p>
          <span className="font-bold text-yellow-300">{stats.openTrades}</span>
        </div>

        {/* WIN RATE */}
        <div>
          <p className="opacity-60 text-xs">Win Rate</p>
          <span className="font-bold">{stats.winRate.toFixed(1)}%</span>
        </div>

        {/* PORTFOLIO VALUE — total deposited + net PnL, your trading equity */}
        <div>
          <p className="opacity-60 text-xs">Portfolio Value</p>
          <span className="font-bold flex items-center gap-1 justify-center">
            <Wallet size={14} className="opacity-70" />
            {formatNumber(stats.portfolioValue, 4)} SOL
          </span>
        </div>

        {/* WALLET BALANCE — your connected wallet's own SOL, not the
            custodial trading wallet */}
        <div>
          <p className="opacity-60 text-xs">Wallet Balance</p>
          <span className="font-bold flex items-center gap-1 justify-center">
            <Wallet size={14} className="opacity-70" />
            {connected ? `${formatNumber(balance, 4)} SOL` : "—"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
