"use client";

import { useEffect, useState } from "react";
import { Card } from "@components/ui/card";
import { fetcher, formatNumber, formatPrice } from "@lib/utils";
import { useParams } from "next/navigation";
import { useWallet } from "@hooks/useWallet";
import { copyText } from "@lib/clipboard";
import { toast } from "react-hot-toast";
import {
  TokenPriceChart,
  PricePoint,
} from "@components/trading/TokenPriceChart";
import { Copy, Check, Loader2, AlertCircle } from "lucide-react";

interface TokenDetails {
  symbol: string;
  mint: string;
  name?: string;
  price?: number;
  priceSol?: number;
  marketCap?: number;
  marketCapSol?: number;
  liquidity?: number;
  volume24h?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  circulatingSupply?: number;
  totalSupply?: number;
}

function ChangePill({
  label,
  value,
}: {
  label: string;
  value?: number | null;
}) {
  if (value == null) {
    return (
      <span className="text-xs px-2 py-1 rounded-full bg-white/5 text-base-content/30">
        {label} —
      </span>
    );
  }
  const positive = value >= 0;
  return (
    <span
      className={`text-xs font-mono tabular-nums font-semibold px-2 py-1 rounded-full ${
        positive ? "bg-success/12 text-success" : "bg-danger/12 text-danger"
      }`}
    >
      {label} {positive ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

function StatBlock({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
      <div className="text-xs text-base-content/40 mb-1.5">{label}</div>
      <div className="font-display text-xl font-semibold text-white tabular-nums">
        {value}
      </div>
    </div>
  );
}

export default function TokenDetailsPage() {
  const { mint } = useParams();
  const [token, setToken] = useState<TokenDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<PricePoint[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [timeframe, setTimeframe] = useState("24h");
  const [copied, setCopied] = useState(false);
  const { publicKey: wallet } = useWallet();

  useEffect(() => {
    if (!mint) return;
    setLoading(true);
    setError(null);
    // Fetch token info from /api/tokens - this is the page's core data and
    // must not be gated behind a wallet connection
    fetcher(`/api/tokens`)
      .then((res) => {
        const tokenInfo = (res.tokens || []).find((t: any) => t.mint === mint);
        if (!tokenInfo) throw new Error("Token not found");
        setToken(tokenInfo);
        setLoading(false);

        // Per-wallet trader config is an optional enhancement layered on top;
        // skip it (rather than block the page) if no wallet is connected
        if (!wallet) return;
        fetcher(`/api/trader-config/${wallet}/effective/${mint}`)
          .then((cfgRes) => {
            setToken((prev) => (prev ? { ...prev, ...cfgRes.config } : prev));
          })
          .catch(() => {
            // Non-fatal: token details already rendered without per-wallet config
          });
      })
      .catch(() => {
        setError("Failed to load token details");
        setLoading(false);
      });
  }, [mint, wallet]);

  useEffect(() => {
    if (!mint) return;
    setChartLoading(true);
    fetcher(`/api/tokens/${mint}/chart?tf=${timeframe}`)
      .then((res) => {
        setChartData(res.data || []);
        setChartLoading(false);
      })
      .catch(() => setChartLoading(false));
  }, [mint, timeframe]);

  const handleCopy = async () => {
    if (!token?.mint) return;
    if (await copyText(token.mint)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } else {
      toast.error("Couldn't copy — select the address and copy it manually.");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-base-content/50">
        <Loader2 className="animate-spin" size={18} />
        Loading token details…
      </div>
    );
  }
  if (error || !token) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-danger">
        <AlertCircle size={24} />
        {error || "Token not found"}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 pb-5 mb-5 border-b border-white/[0.06]">
          <div>
            <div className="flex items-baseline gap-2">
              <h1 className="font-display text-2xl font-bold text-white">
                {token.symbol}
              </h1>
              {token.name && (
                <span className="text-base-content/40 text-sm">
                  {token.name}
                </span>
              )}
            </div>
            <button
              onClick={handleCopy}
              className="mt-2 flex items-center gap-1.5 text-xs font-mono text-base-content/40 hover:text-base-content transition group"
              title="Copy contract address"
            >
              {token.mint.slice(0, 12)}...{token.mint.slice(-6)}
              {copied ? (
                <Check size={13} className="text-success" />
              ) : (
                <Copy
                  size={13}
                  className="opacity-0 group-hover:opacity-100 transition"
                />
              )}
            </button>
          </div>

          <div className="text-right">
            <div className="text-xs text-base-content/40 mb-1">
              Current Price
            </div>
            <div className="font-display text-2xl font-bold text-white tabular-nums">
              {token.price
                ? `$${formatPrice(token.price)}`
                : token.priceSol
                  ? `${token.priceSol.toFixed(8)} SOL`
                  : "—"}
            </div>
            <div className="flex gap-1.5 mt-1.5 justify-end">
              <ChangePill label="1h" value={token.priceChange1h} />
              <ChangePill label="24h" value={token.priceChange24h} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatBlock
            label="Market Cap"
            value={
              token.marketCap
                ? `$${formatNumber(token.marketCap)}`
                : token.marketCapSol
                  ? `${token.marketCapSol.toFixed(2)} SOL`
                  : "—"
            }
          />
          <StatBlock
            label="24h Volume"
            value={token.volume24h ? `$${formatNumber(token.volume24h)}` : "—"}
          />
          <StatBlock
            label="Liquidity"
            value={token.liquidity ? `$${formatNumber(token.liquidity)}` : "—"}
          />
          <StatBlock
            label="Supply"
            value={
              <span className="text-sm">
                {token.circulatingSupply
                  ? formatNumber(token.circulatingSupply)
                  : "—"}{" "}
                <span className="text-base-content/30">/</span>{" "}
                {token.totalSupply ? formatNumber(token.totalSupply) : "—"}
              </span>
            }
          />
        </div>
      </Card>

      <Card>
        <TokenPriceChart
          data={chartData}
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          loading={chartLoading}
        />
      </Card>
    </div>
  );
}
