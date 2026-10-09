"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Table, Spinner } from "../ui/table";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { WalletBalance } from "../ui";
import { Archive, Search, X, ShoppingCart } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export type OldToken = {
  mint: string;
  symbol?: string;
  name?: string;
  analytics?: {
    priceChange1h?: number;
    priceChange24h?: number;
    priceChange7d?: number;
    volume1h?: number;
    volume24h?: number;
    volume7d?: number;
    liquidityHistory?: Array<{
      timestamp: string;
      price: number;
      liquidityUSD?: number;
    }>;
  };
  priceHistory?: Array<{ timestamp: string; price: number }>;
  signals?: Array<{ type: string; description: string; triggeredAt: string }>;
  liquidityUSD?: number;
  volume24h?: number;
  isOldToken?: boolean;
};

// Backend's real default PORT is 4000 (see backend/src/utils/env.ts) — every
// other frontend file's fallback agrees (lib/utils.ts's fetcher, useTokenPrice.ts).
// This one alone said 3001, so without NEXT_PUBLIC_BACKEND_URL set explicitly
// it silently pointed at a port nothing listens on.
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

function ChangeBadge({ value }: { value?: number | null }) {
  if (value == null)
    return <span className="text-base-content/30">—</span>;
  const positive = value >= 0;
  return (
    <span
      className={`font-mono tabular-nums font-medium ${
        positive ? "text-success" : "text-danger"
      }`}
    >
      {positive ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

export default function OldTokensDashboard() {
  const [tokens, setTokens] = useState<OldToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OldToken | null>(null);
  const [details, setDetails] = useState<OldToken | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // Filters
  const [filter, setFilter] = useState({
    symbol: "",
    minLiquidity: "",
    minVolume: "",
    minChange7d: "",
  });

  // Min Liquidity / Min 24h Volume are real query params the backend uses to
  // select the token universe in the first place (getOldTokenUniverse) — they
  // must be sent to the server, not applied only to the 50 rows it already
  // decided to return. Debounced so each keystroke doesn't trigger a fetch.
  // Symbol and Min 7d Change stay client-side refinements below: symbol
  // search doesn't need a round-trip, and the backend has no 7d-change filter.
  useEffect(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (filter.minLiquidity) params.set("minLiquidityUSD", filter.minLiquidity);
    if (filter.minVolume) params.set("minVolume24h", filter.minVolume);

    setLoading(true);
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/old-tokens?${params.toString()}`)
        .then((r) => r.json())
        .then((data) => {
          setTokens(data.tokens || []);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, 400);

    return () => clearTimeout(t);
  }, [filter.minLiquidity, filter.minVolume]);

  const loadDetails = async (mint: string) => {
    setDetailsLoading(true);
    setDetails(null);
    const res = await fetch(`${API_URL}/api/old-tokens/${mint}`);
    const data = await res.json();
    setDetails(data.token || null);
    setDetailsLoading(false);
  };

  // Filter tokens
  const filteredTokens = tokens.filter((t) => {
    if (
      filter.symbol &&
      !(t.symbol || "").toLowerCase().includes(filter.symbol.toLowerCase())
    )
      return false;
    if (
      filter.minLiquidity &&
      (t.liquidityUSD || 0) < Number(filter.minLiquidity)
    )
      return false;
    if (
      filter.minVolume &&
      (t.analytics?.volume24h || 0) < Number(filter.minVolume)
    )
      return false;
    if (
      filter.minChange7d &&
      (t.analytics?.priceChange7d || 0) < Number(filter.minChange7d)
    )
      return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="kicker mb-1">Analytics</div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-2.5">
            <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/15 text-primary">
              <Archive size={18} />
            </span>
            Old Tokens
          </h1>
        </div>
        <WalletBalance />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Search size={16} className="text-base-content/40" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div>
              <Label htmlFor="filter-symbol">Symbol</Label>
              <Input
                id="filter-symbol"
                placeholder="e.g. BONK"
                value={filter.symbol}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, symbol: e.target.value }))
                }
                className="w-36 mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="filter-liquidity">Min Liquidity ($)</Label>
              <Input
                id="filter-liquidity"
                type="number"
                placeholder="0"
                value={filter.minLiquidity}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, minLiquidity: e.target.value }))
                }
                className="w-36 mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="filter-volume">Min 24h Volume ($)</Label>
              <Input
                id="filter-volume"
                type="number"
                placeholder="0"
                value={filter.minVolume}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, minVolume: e.target.value }))
                }
                className="w-36 mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="filter-change7d">Min 7d Change (%)</Label>
              <Input
                id="filter-change7d"
                type="number"
                placeholder="0"
                value={filter.minChange7d}
                onChange={(e) =>
                  setFilter((f) => ({ ...f, minChange7d: e.target.value }))
                }
                className="w-36 mt-1.5"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="py-10">
            <Spinner />
          </div>
        ) : filteredTokens.length === 0 ? (
          <div className="text-center py-10 text-sm text-base-content/40">
            No tokens match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th className="text-right">Liquidity</th>
                  <th className="text-right">24h Volume</th>
                  <th className="text-right">7d Change</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTokens.map((t) => (
                  <tr
                    key={t.mint}
                    className={
                      selected?.mint === t.mint ? "bg-primary/[0.06]" : ""
                    }
                  >
                    <td className="font-semibold text-white">{t.symbol}</td>
                    <td className="text-base-content/60">{t.name}</td>
                    <td className="text-right font-mono tabular-nums">
                      {t.liquidityUSD != null
                        ? `$${t.liquidityUSD.toLocaleString(undefined, {
                            maximumFractionDigits: 0,
                          })}`
                        : "—"}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {t.analytics?.volume24h != null
                        ? `$${t.analytics.volume24h.toLocaleString(undefined, {
                            maximumFractionDigits: 0,
                          })}`
                        : "—"}
                    </td>
                    <td className="text-right">
                      <ChangeBadge value={t.analytics?.priceChange7d} />
                    </td>
                    <td className="text-right">
                      <Button
                        onClick={() => {
                          setSelected(t);
                          loadDetails(t.mint);
                        }}
                        size="sm"
                        variant={selected?.mint === t.mint ? "primary" : "secondary"}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      {selected && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>{selected.symbol}</CardTitle>
              <p className="text-xs text-base-content/40 font-mono mt-0.5">
                {selected.mint}
              </p>
            </div>
            <button
              onClick={() => {
                setSelected(null);
                setDetails(null);
              }}
              className="text-base-content/40 hover:text-base-content transition p-1"
              aria-label="Close details"
            >
              <X size={18} />
            </button>
          </CardHeader>

          {detailsLoading ? (
            <Spinner />
          ) : details ? (
            <CardContent className="space-y-6">
              {/* Stat grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "1h", value: details.analytics?.priceChange1h },
                  { label: "24h", value: details.analytics?.priceChange24h },
                  { label: "7d", value: details.analytics?.priceChange7d },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-center"
                  >
                    <div className="text-xs text-base-content/40 mb-1">
                      {s.label} Change
                    </div>
                    <ChangeBadge value={s.value} />
                  </div>
                ))}
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 text-center">
                  <div className="text-xs text-base-content/40 mb-1">
                    Liquidity
                  </div>
                  <div className="font-mono tabular-nums font-medium text-white">
                    ${details.liquidityUSD?.toLocaleString() ?? "—"}
                  </div>
                </div>
              </div>

              {/* Price history */}
              <div>
                <div className="kicker mb-2">Price History</div>
                <div style={{ height: 260 }}>
                  <ResponsiveContainer>
                    <LineChart data={details.priceHistory || []}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="rgba(255,255,255,0.06)"
                      />
                      <XAxis
                        dataKey="timestamp"
                        stroke="rgba(255,255,255,0.3)"
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis
                        stroke="rgba(255,255,255,0.3)"
                        tick={{ fontSize: 11 }}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#100F17",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 10,
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="price"
                        stroke="#8B5CF6"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 5 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Signals */}
              <div>
                <div className="kicker mb-2">Signals</div>
                {details.signals?.length ? (
                  <div className="space-y-1.5">
                    {details.signals.map((s, i) => (
                      <div
                        key={i}
                        className="text-sm bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 flex items-center justify-between"
                      >
                        <span>
                          <span className="text-primary font-medium">
                            {s.type}
                          </span>{" "}
                          — {s.description}
                        </span>
                        <span className="text-xs text-base-content/40">
                          {new Date(s.triggeredAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-base-content/40">No signals</p>
                )}
              </div>

              <ManualBuyPanel token={selected} />
            </CardContent>
          ) : null}
        </Card>
      )}
    </div>
  );
}

// Links into the real, tested manual-buy flow (/trading/buy) instead of
// executing here directly — this used to sign every "manual" buy with the
// operator's own env-configured wallet regardless of who was connected
// (useManualBuy → /api/trade/manual-buy → executeManualBuy, which never
// accepted a signer override), a real fund-misattribution bug, not a
// shortcut worth keeping. The Buy page only lists the bot's own validated
// tokens, so an old/inactive token may not preselect there — that's
// intentional, not a bug: buying now re-validates safety at that moment,
// which an old token failing means it genuinely shouldn't be bought blind.
function ManualBuyPanel({ token }: { token: OldToken }) {
  const router = useRouter();

  return (
    <div className="border border-warning/20 bg-warning/[0.04] rounded-xl p-4">
      <div className="mb-3 font-display font-semibold text-warning text-sm">
        Buy {token.symbol || "this token"}
      </div>
      <Button
        onClick={() => router.push(`/trading/buy?mint=${token.mint}`)}
        variant="secondary"
        className="w-full"
      >
        <ShoppingCart className="h-4 w-4" />
        Buy {token.symbol || token.mint}
      </Button>
      <p className="text-xs text-base-content/40 mt-2">
        Re-checks the bot&apos;s own safety validation at the moment you buy —
        signed by your own connected wallet, not the bot&apos;s.
      </p>
    </div>
  );
}
