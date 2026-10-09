// components/trading/PositionsPanel.tsx
"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { fetcher, formatNumber, formatPrice } from "@lib/utils";
import { useSocket } from "@hooks/useSocket";
import { useTrailingStop } from "@hooks/useTrailingStop";
import { useSellBotPosition } from "@hooks/useSellBotPosition";
import { TrancheProgress } from "@components/trading/TrancheProgress";
import {
  Loader2,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

type Position = {
  token: string;
  wallet?: string;
  custody?: "self" | "custodial" | null;
  netSol: number;
  avgBuyPrice?: number;
  currentPrice?: number;
  unrealizedPnlPct?: number; // Decimal fraction from positions.route.ts (0.05 = +5%)
  // Tranche/tier metadata — db.service.ts's getPositions() merges these in
  // from positionMetadataCol; see TrancheProgress.tsx for how they render.
  firstTrancheEntry?: number;
  secondTrancheEntry?: number;
  remainingPct?: number;
  soldAt40?: boolean;
  soldAt80?: boolean;
  soldAt150?: boolean;
  trailingActivated?: boolean;
  highestPnlPct?: number;
  // This position's own exit levels (decimals), snapshotted when it was
  // bought — see monitor.service.ts.
  tpPct?: number;
  slPct?: number;
};

export const PositionsPanel: React.FC = () => {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { lastMessage, connected } = useSocket();
  const { allTrailingData } = useTrailingStop();
  const { publicKey } = useSolanaWallet();

  // Clear the instant the connected wallet changes, before the re-fetch
  // below even starts — otherwise the previous wallet's positions stay on
  // screen for the round-trip it takes to load the new wallet's own.
  useEffect(() => {
    setPositions([]);
  }, [publicKey]);

  const loadPositions = useCallback(async () => {
    setLoading(true);
    try {
      // Scoped to the connected wallet — the bot's own positions plus this
      // wallet's own, never another wallet's (see positions.route.ts).
      const walletParam = publicKey
        ? `?wallet=${encodeURIComponent(publicKey.toString())}`
        : "";
      const data = await fetcher(`/api/positions${walletParam}`);
      if (data?.positions) {
        setPositions(data.positions);
      }
    } catch (err) {
      console.warn("Failed loading positions:", err);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    loadPositions();
    const t = setInterval(loadPositions, 15000);
    return () => clearInterval(t);
  }, [loadPositions]);

  // Sell button for positions the bot holds (a manual position is sold from
  // your own wallet on the Sell page instead).
  const { sell, selling } = useSellBotPosition(loadPositions);

  // 🔥 Handle live updates
  useEffect(() => {
    if (!lastMessage) return;

    if (
      lastMessage.event === "tradeFeed" ||
      lastMessage.event === "position:update"
    ) {
      loadPositions();
    }
  }, [lastMessage, loadPositions]);

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-primary flex justify-between">
          <span>Positions</span>
          <span className={connected ? "text-green-400" : "text-red-400"}>
            {connected ? "Live" : "Offline"}
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent>
        {loading && positions.length === 0 ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="animate-spin" />
            <span className="text-sm text-gray-400">Loading positions...</span>
          </div>
        ) : positions.length === 0 ? (
          <div className="text-sm text-gray-400 py-4">No open positions.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-base-300">
                  <th className="py-2 w-6"></th>
                  <th className="py-2">Token</th>
                  <th className="py-2 text-right">Net (SOL)</th>
                  <th className="py-2 text-right">Avg Buy</th>
                  <th className="py-2 text-right">Price</th>
                  <th className="py-2 text-right">Unrealized PnL</th>
                  <th className="py-2 text-right">Trailing Stop</th>
                  <th className="py-2 text-right"></th>
                </tr>
              </thead>

              <tbody>
                {positions.map((p) => {
                  // Backend sends a decimal fraction (0.05 = +5%); this table
                  // displays a whole-number percent.
                  const pnlFraction = p.unrealizedPnlPct ?? 0;
                  const pctDisplay = pnlFraction * 100;
                  const pnlColor =
                    pctDisplay >= 0 ? "text-green-400" : "text-red-400";
                  const positionKey = `${p.token}:${p.wallet ?? ""}:${p.custody ?? "legacy"}`;
                  const trailing = allTrailingData.get(
                    `${p.wallet ?? ""}:${p.token}`
                  );
                  const isExpanded = expanded === positionKey;

                  return (
                    <React.Fragment key={positionKey}>
                      <tr
                        className="border-b border-base-300 hover:bg-base-300/20 transition cursor-pointer"
                        onClick={() =>
                          setExpanded(isExpanded ? null : positionKey)
                        }
                      >
                        <td className="py-2 text-gray-500">
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </td>

                        <td className="py-2 font-medium">
                          <Link
                            href={`/trading/${p.token}`}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 hover:text-primary hover:underline"
                            title="View full token details"
                          >
                            {p.token}
                            <ExternalLink className="h-3 w-3 opacity-50" />
                          </Link>
                        </td>

                        <td className="py-2 text-right">
                          {formatNumber(p.netSol)}
                        </td>

                        <td className="py-2 text-right">
                          {p.avgBuyPrice ? formatPrice(p.avgBuyPrice) : "—"}
                        </td>

                        <td className="py-2 text-right">
                          {p.currentPrice ? formatPrice(p.currentPrice) : "—"}
                        </td>

                        <td
                          className={`py-2 text-right font-semibold ${pnlColor}`}
                        >
                          {pctDisplay.toFixed(2)}%
                        </td>

                        <td className="py-2 text-right">
                          {trailing?.trailingActivated ? (
                            <span
                              className="inline-flex items-center gap-1 text-orange-400"
                              title={`Armed at +${trailing.trailingActivationPct}% — exits on a ${trailing.trailingStopPct}% pullback from peak`}
                            >
                              <TrendingDown className="h-3 w-3" />−
                              {trailing.drawdownFromPeak.toFixed(1)}% from peak
                            </span>
                          ) : (
                            <span className="text-gray-600">Not armed</span>
                          )}
                        </td>

                        <td
                          className="py-2 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.custody === "self" ? (
                            <Link
                              href="/trading/sell"
                              className="text-xs px-2 py-1 rounded border border-base-300 hover:border-primary hover:text-primary transition"
                              title="Manual positions are sold from your own wallet on the Sell page"
                            >
                              Sell
                            </Link>
                          ) : (
                            <button
                              onClick={() =>
                                sell(
                                  p.token,
                                  `${p.token.slice(0, 4)}…${p.token.slice(-4)}`
                                )
                              }
                              disabled={selling !== null}
                              className="text-xs px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Sell this whole position now"
                            >
                              {selling === p.token ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                "Sell"
                              )}
                            </button>
                          )}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="border-b border-base-300">
                          <td></td>
                          <td colSpan={7} className="pb-3 pt-1">
                            <TrancheProgress
                              token={p.token}
                              firstTrancheEntry={p.firstTrancheEntry}
                              secondTrancheEntry={p.secondTrancheEntry}
                              remainingPct={p.remainingPct}
                              soldAt40={p.soldAt40}
                              soldAt80={p.soldAt80}
                              soldAt150={p.soldAt150}
                              currentPnl={pnlFraction}
                              tpPct={p.tpPct}
                              slPct={p.slPct}
                              trailingActivated={
                                trailing?.trailingActivated ??
                                p.trailingActivated
                              }
                              highestPnlPct={
                                trailing?.highestPnlPct ?? p.highestPnlPct
                              }
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default PositionsPanel;
