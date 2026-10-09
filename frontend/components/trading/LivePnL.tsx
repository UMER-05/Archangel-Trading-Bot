"use client";

import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { useJupiterEvents } from "@hooks/useJupiterEvents";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export const LivePnL: React.FC = () => {
  const { pnlUpdates, connected } = useJupiterEvents();

  const pnlArray = Array.from(pnlUpdates.values());

  const getTrendIcon = (direction: "up" | "down" | "stable") => {
    switch (direction) {
      case "up":
        return <TrendingUp className="w-4 h-4 text-green-400" />;
      case "down":
        return <TrendingDown className="w-4 h-4 text-red-400" />;
      default:
        return <Minus className="w-4 h-4 text-gray-400" />;
    }
  };

  const getTrendColor = (direction: "up" | "down" | "stable") => {
    switch (direction) {
      case "up":
        return "text-green-400";
      case "down":
        return "text-red-400";
      default:
        return "text-gray-400";
    }
  };

  const formatPnL = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(6)} SOL`;
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="text-lg font-semibold text-primary">
          Live P&L Tracking
        </CardTitle>

        <div
          className={`flex items-center gap-2 text-xs ${
            connected ? "text-green-400" : "text-red-400"
          }`}
        >
          <div
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-green-400 animate-pulse" : "bg-red-400"
            }`}
          />
          {connected ? "Live" : "Offline"}
        </div>
      </CardHeader>

      <CardContent>
        {pnlArray.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center">
            No active positions. Buy a token to start tracking P&L.
          </div>
        ) : (
          <div className="space-y-3">
            {pnlArray.map((pnl) => (
              <div
                key={pnl.tokenMint}
                className="p-3 bg-base-300/50 rounded-lg border border-base-300 hover:border-primary/30 transition"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {getTrendIcon(pnl.trendDirection)}
                    <code className="text-sm font-mono text-gray-300">
                      {pnl.tokenMint.slice(0, 8)}...
                      {pnl.tokenMint.slice(-4)}
                    </code>
                  </div>

                  <div
                    className={`text-right ${
                      pnl.unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    <div className="text-sm font-semibold">
                      {formatPnL(pnl.unrealizedPnL)}
                    </div>
                    <div className="text-xs">
                      {formatPercent(pnl.percentChange)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-gray-400">Entry:</span>{" "}
                    <span className="text-gray-300">
                      {pnl.entryPrice.toFixed(8)} SOL
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Current:</span>{" "}
                    <span className="text-gray-300">
                      {pnl.currentPrice.toFixed(8)} SOL
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Amount:</span>{" "}
                    <span className="text-gray-300">
                      {pnl.amount.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-400">Price Impact:</span>{" "}
                    <span className="text-gray-300">
                      {pnl.priceImpact.toFixed(2)}%
                    </span>
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-base-300">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Liquidity Movement:</span>
                    <span
                      className={
                        pnl.liquidityMovement >= 0
                          ? "text-green-400"
                          : "text-red-400"
                      }
                    >
                      {pnl.liquidityMovement >= 0 ? "+" : ""}
                      {pnl.liquidityMovement.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span className="text-gray-400">Trend:</span>
                    <span className={getTrendColor(pnl.trendDirection)}>
                      {pnl.trendDirection.toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default LivePnL;
