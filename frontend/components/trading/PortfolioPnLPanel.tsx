"use client";

import React from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { formatNumber } from "@lib/utils";
import { usePnLData } from "@hooks/usePnLData";

function StatCard({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="bg-base-300/30 rounded-lg p-3 text-center">
      <div className="text-xs text-gray-400 uppercase tracking-wide">
        {label}
      </div>
      <div
        className={`text-lg font-bold mt-1 ${
          positive === undefined
            ? "text-white"
            : positive
            ? "text-green-400"
            : "text-red-400"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default function PortfolioPnLPanel() {
  const { portfolio, tokenPnL, history, loading, error } = usePnLData(30);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 justify-center">
          <Loader2 className="animate-spin" size={18} />
          <span className="text-sm text-gray-400">Loading P&L data...</span>
        </CardContent>
      </Card>
    );
  }

  if (error || !portfolio) {
    return (
      <Card>
        <CardContent className="text-center text-red-400 py-6">
          {error || "No P&L data available"}
        </CardContent>
      </Card>
    );
  }

  const chartData = history.map((h) => ({
    date: h.date.slice(5), // MM-DD, the year rarely matters day-to-day here
    pnl: h.realizedPnlSol,
    trades: h.tradeCount,
    winRate: h.winRate,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {portfolio.totalPnlSol >= 0 ? (
            <TrendingUp className="text-green-400" size={18} />
          ) : (
            <TrendingDown className="text-red-400" size={18} />
          )}
          Portfolio P&L
        </CardTitle>
      </CardHeader>

      <CardContent>
        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Total P&L"
            value={`${portfolio.totalPnlSol >= 0 ? "+" : ""}${formatNumber(
              portfolio.totalPnlSol,
              4
            )} SOL`}
            positive={portfolio.totalPnlSol >= 0}
          />
          <StatCard
            label="Total P&L %"
            value={`${portfolio.totalPnlPercent >= 0 ? "+" : ""}${formatNumber(
              portfolio.totalPnlPercent
            )}%`}
            positive={portfolio.totalPnlPercent >= 0}
          />
          <StatCard
            label="Realized"
            value={`${formatNumber(portfolio.realizedPnlSol, 4)} SOL`}
            positive={portfolio.realizedPnlSol >= 0}
          />
          <StatCard
            label="Unrealized"
            value={`${formatNumber(portfolio.unrealizedPnlSol, 4)} SOL`}
            positive={portfolio.unrealizedPnlSol >= 0}
          />
          <StatCard
            label="Win Rate"
            value={`${formatNumber(portfolio.winRate)}%`}
          />
          <StatCard label="ROI" value={`${formatNumber(portfolio.roi)}%`} positive={portfolio.roi >= 0} />
          <StatCard
            label="Winning / Losing"
            value={`${portfolio.winningTrades} / ${portfolio.losingTrades}`}
          />
          <StatCard
            label="Total Trades"
            value={`${portfolio.totalTrades}`}
          />
          <StatCard
            label="Avg Win"
            value={`${formatNumber(portfolio.averageWinSol, 4)} SOL`}
            positive
          />
          <StatCard
            label="Avg Loss"
            value={`${formatNumber(portfolio.averageLossSol, 4)} SOL`}
            positive={false}
          />
          <StatCard
            label="Largest Win"
            value={`${formatNumber(portfolio.largestWinSol, 4)} SOL`}
            positive
          />
          <StatCard
            label="Largest Loss"
            value={`${formatNumber(portfolio.largestLossSol, 4)} SOL`}
            positive={false}
          />
        </div>

        {/* Daily realized P&L history */}
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">
            Daily Realized P&L (30d)
          </h3>
          {chartData.length === 0 ? (
            <div className="text-sm text-gray-500 italic py-4 text-center">
              No closed trades yet in this window.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="date" stroke="#888" fontSize={11} />
                <YAxis stroke="#888" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1d1f21",
                    borderRadius: "8px",
                    border: "1px solid #333",
                  }}
                  formatter={(value: number, name: string) =>
                    name === "pnl" ? [`${formatNumber(value, 4)} SOL`, "P&L"] : [value, name]
                  }
                />
                <Bar dataKey="pnl">
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? "#22c55e" : "#ef4444"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Per-token breakdown */}
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">
            P&L by Token
          </h3>
          {tokenPnL.length === 0 ? (
            <div className="text-sm text-gray-500 italic py-4 text-center">
              No trades recorded yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-base-300">
              <div className="max-h-[320px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-base-200 z-10">
                    <tr className="text-left text-gray-400 border-b border-base-300">
                      <th className="py-2 px-3">Token</th>
                      <th className="py-2 px-3 text-right">Bought</th>
                      <th className="py-2 px-3 text-right">Sold</th>
                      <th className="py-2 px-3 text-right">P&L</th>
                      <th className="py-2 px-3 text-right">Trades</th>
                      <th className="py-2 px-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokenPnL.map((t) => (
                      <tr
                        key={t.token}
                        className="border-b border-base-300 hover:bg-base-300/20"
                      >
                        <td className="py-2 px-3 font-mono">
                          {t.symbol || `${t.token.slice(0, 8)}...`}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {formatNumber(t.totalBought, 4)} SOL
                        </td>
                        <td className="py-2 px-3 text-right">
                          {formatNumber(t.totalSold, 4)} SOL
                        </td>
                        <td
                          className={`py-2 px-3 text-right ${
                            t.pnlSol >= 0 ? "text-green-400" : "text-red-400"
                          }`}
                        >
                          {t.pnlSol >= 0 ? "+" : ""}
                          {formatNumber(t.pnlSol, 4)} SOL (
                          {t.pnlPercent >= 0 ? "+" : ""}
                          {formatNumber(t.pnlPercent)}%)
                        </td>
                        <td className="py-2 px-3 text-right">{t.trades}</td>
                        <td className="py-2 px-3 text-right">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] uppercase ${
                              t.status === "open"
                                ? "bg-yellow-500/20 text-yellow-400"
                                : "bg-gray-500/20 text-gray-400"
                            }`}
                          >
                            {t.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
