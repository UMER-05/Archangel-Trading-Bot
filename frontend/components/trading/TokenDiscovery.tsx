"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { fetcher, formatNumber, formatPrice } from "@lib/utils";
import { useSocketEvent } from "@hooks/useSocketEvent";
import { useCandidateEvents } from "@hooks/useCandidateEvents";
import { Loader2, CheckCircle, XCircle, Ban, ShoppingCart } from "lucide-react";

type TokenItem = {
  symbol: string;
  name?: string;
  mint?: string;
  price: number;
  pnl?: number;
  liquidity?: number;
  marketCap?: number;
};

type TokensResponse = {
  success: boolean;
  tokens: TokenItem[];
};

export const TokenDiscovery: React.FC = () => {
  const router = useRouter();
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Live pipeline activity — from the backend's candidate:* events (see
  // hooks/useCandidateEvents.ts). This used to listen for jupiter:* events that
  // are no longer sent, so the feed and both lists were always empty.
  const {
    connected,
    approved,
    passedOn,
    latestBought,
    latestSkipped,
    latestApproved,
    latestPassedOn,
  } = useCandidateEvents();

  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetcher<TokensResponse>("/api/tokens");
      if (res?.success && Array.isArray(res.tokens)) {
        setTokens(res.tokens);
      }
    } catch (err) {
      console.warn("❌ Failed to load tokens:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
    const interval = setInterval(loadTokens, 10000);
    return () => clearInterval(interval);
  }, [loadTokens]);

  // 🔄 Live price updates from websocket
  useSocketEvent<{ tokens?: TokenItem[] }>("token_prices", (payload) => {
    if (Array.isArray(payload?.tokens)) setTokens(payload.tokens);
  });

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4 flex flex-col max-h-[900px]">
      <CardHeader className="flex items-center justify-between flex-shrink-0">
        <CardTitle className="text-lg font-semibold text-primary">
          New Token Discovery
        </CardTitle>

        <div
          className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}
        >
          {connected ? "Live" : "Offline"}
        </div>
      </CardHeader>

      <CardContent className="overflow-y-auto flex-1 pr-2">
        {/* Live Activity Feed */}
        <div className="mb-4 space-y-2 max-h-[300px] overflow-y-auto pr-2">
          {!latestBought &&
            !latestSkipped &&
            !latestApproved &&
            !latestPassedOn && (
              <div className="text-xs text-gray-500 py-2">
                Waiting for new tokens — what the bot does with each one shows
                up here as it happens.
              </div>
            )}

          {/* The bot bought a token for this wallet */}
          {latestBought && (
            <div className="flex items-center gap-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-xs">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-emerald-400">🚀 Bought:</span>
              <code className="text-gray-300">
                {latestBought.mint.slice(0, 8)}...
              </code>
              <span className="text-gray-400">
                (
                {latestBought.tokensReceived != null
                  ? latestBought.tokensReceived.toFixed(0)
                  : "?"}{" "}
                tokens @{" "}
                {latestBought.actualPrice != null
                  ? latestBought.actualPrice.toFixed(6)
                  : "?"}{" "}
                SOL)
              </span>
              {latestBought.signature && (
                <a
                  href={`https://solscan.io/tx/${latestBought.signature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 hover:underline"
                >
                  Tx
                </a>
              )}
            </div>
          )}

          {/* The bot wanted a token but this wallet couldn't take it */}
          {latestSkipped && (
            <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs">
              <XCircle className="w-4 h-4 text-red-400" />
              <span className="text-red-400">⏭️ Skipped for you:</span>
              <code className="text-gray-300">
                {latestSkipped.mint.slice(0, 8)}...
              </code>
              <span className="text-orange-300 text-xs">
                {latestSkipped.failedStageName
                  ? `${latestSkipped.failedStageName} - `
                  : ""}
                {latestSkipped.reason}
              </span>
            </div>
          )}

          {/* A token passed every safety filter */}
          {latestApproved && (
            <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/20 rounded text-xs">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-green-400">✅ Passed all filters:</span>
              <code className="text-gray-300">
                {latestApproved.mint.slice(0, 8)}...
              </code>
            </div>
          )}

          {/* The bot passed on a token */}
          {latestPassedOn && (
            <div className="flex items-center gap-2 p-2 bg-orange-500/10 border border-orange-500/20 rounded text-xs">
              <Ban className="w-4 h-4 text-orange-400" />
              <span className="text-orange-400">🚫 Passed on:</span>
              <code className="text-gray-300">
                {latestPassedOn.mint.slice(0, 8)}...
              </code>
              <span className="text-xs text-orange-300">
                - {latestPassedOn.reason}
              </span>
            </div>
          )}
        </div>

        {/* Tokens that cleared every safety filter. The bot buys these for
            wallets that have auto-trade on; anyone can also buy one by hand
            (the buy re-checks safety at purchase time). */}
        {approved.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-green-400 mb-2 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4" />
              Passed all filters ({approved.length})
            </h3>
            <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2">
              {approved.slice(0, 20).map((token) => (
                <div
                  key={token.mint}
                  className="flex items-center justify-between p-3 bg-green-500/5 border border-green-500/20 rounded"
                >
                  <code className="text-sm font-mono text-gray-300">
                    {token.mint.slice(0, 12)}...
                  </code>
                  <button
                    onClick={() =>
                      router.push(`/trading/buy?mint=${token.mint}`)
                    }
                    className="text-xs px-3 py-1 rounded bg-primary text-white hover:opacity-90 transition"
                  >
                    Buy
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tokens the bot passed on — listed so you can see WHY, and not
            buyable from here: they failed the bot's own safety criteria. */}
        {passedOn.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-orange-400 mb-2 flex items-center gap-2">
              <Ban className="w-4 h-4" />
              Passed on ({passedOn.length})
            </h3>
            <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2">
              {passedOn.slice(0, 20).map((token) => (
                <div
                  key={token.mint}
                  className="p-3 bg-orange-500/5 border border-orange-500/20 rounded"
                >
                  <code className="text-sm font-mono text-gray-300">
                    {token.mint.slice(0, 12)}...
                  </code>
                  <div className="text-xs text-orange-300 mt-1">
                    {token.reason}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token List */}
        {loading ? (
          <div className="flex items-center gap-2 py-6">
            <Loader2 className="animate-spin" />
            <span className="text-sm text-gray-400">Loading tokens...</span>
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-sm text-gray-400 py-4">
            No tokens tracked yet. Validated pools will appear here.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-base-300">
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-base-200 z-10">
                  <tr className="text-left text-gray-400 border-b border-base-300">
                    <th className="py-2 px-4">Token</th>
                    <th className="py-2 px-4 text-right">Price (SOL)</th>
                    <th className="py-2 px-4 text-right">Liquidity</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr
                      key={t.mint || t.symbol}
                      onClick={() =>
                        t.mint && router.push(`/trading/buy?mint=${t.mint}`)
                      }
                      className={`border-b border-base-300 hover:bg-base-300/20 transition ${
                        t.mint ? "cursor-pointer" : ""
                      }`}
                      title={t.mint ? "Buy this token" : undefined}
                    >
                      <td className="py-2 px-4 font-medium">
                        {t.name ?? t.symbol}{" "}
                        <span className="text-xs opacity-60">({t.symbol})</span>
                      </td>

                      <td className="py-2 px-4 text-right">
                        {formatPrice(t.price ?? 0)}
                      </td>

                      <td className="py-2 px-4 text-right">
                        {t.liquidity ? formatNumber(t.liquidity) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TokenDiscovery;
