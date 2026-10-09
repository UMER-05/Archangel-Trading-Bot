"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@components/ui/card";
import { Input } from "@components/ui/input";
import { Button } from "@components/ui/button";
import { fetcher, formatNumber, truncateAddress } from "@lib/utils";
import { useWallet } from "@hooks/useWallet";
import { useTrade } from "@hooks/useTrade";
import { ArrowLeft, Loader2, TrendingUp } from "lucide-react";
import { toast } from "react-hot-toast";

interface BuyCandidate {
  mint: string;
  symbol: string;
  name: string;
  liquidityUSD: number;
  liquiditySOL: number;
  marketCapUSD: number;
  poolAddress: string | null;
  tradableAt: string | null;
}

// Rough network-fee + rent buffer — leaves enough SOL uncommitted to
// actually pay for the swap transaction itself, so "spend my whole balance"
// doesn't fail on-chain from having nothing left for fees.
const FEE_BUFFER_SOL = 0.005;

// useSearchParams() opts this subtree out of static rendering unless it's
// isolated behind a Suspense boundary — see the default export below.
function BuyPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectMint = searchParams.get("mint");
  const { connected, balance, refreshBalance } = useWallet();
  const { executeTrade, loading: submitting } = useTrade();

  const [candidates, setCandidates] = useState<BuyCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<BuyCandidate | null>(null);
  const [amountSol, setAmountSol] = useState(0.1);
  // A token reached by link (e.g. from Old Tokens) that isn't on the bot's
  // list is safety-checked on the spot instead of being turned away.
  const [checking, setChecking] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const [offList, setOffList] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetcher<{
          success: boolean;
          candidates: BuyCandidate[];
        }>("/api/trade/manual-buy-candidates?limit=40");
        if (!mounted || !res?.success) return;
        const list = res.candidates || [];
        setCandidates(list);
        // Arrived via a link naming a specific token (e.g. TokenDiscovery's
        // "Buy" button) — jump straight to its detail/amount step instead of
        // making them find it again in the list.
        if (preselectMint) {
          const match = list.find((c) => c.mint === preselectMint);
          if (match) {
            setSelected(match);
          } else {
            // Not on the bot's list. That list is only a convenience — the
            // buy itself re-validates at purchase time — so check THIS token
            // now: if it passes, let the user buy it; if not, say why.
            setChecking(true);
            try {
              const res = await fetcher<{
                success: boolean;
                validation: {
                  approved: boolean;
                  reason: string;
                  jupiterMetrics?: {
                    liquiditySOL?: number;
                    liquidityUSD?: number;
                    mcapUSD?: number;
                    poolAddress?: string;
                  };
                };
              }>("/api/trade/validate", {
                method: "POST",
                body: JSON.stringify({ tokenMint: preselectMint }),
              });
              if (!mounted) return;
              const v = res?.validation;
              if (v?.approved) {
                let symbol = truncateAddress(preselectMint);
                let name = "";
                try {
                  // Best effort: known tokens carry a real symbol and name.
                  const d = await fetcher<{
                    success: boolean;
                    token?: { symbol?: string; name?: string };
                  }>(`/api/old-tokens/${preselectMint}`);
                  if (d?.token?.symbol && d.token.symbol !== "UNKNOWN") {
                    symbol = d.token.symbol;
                  }
                  name = d?.token?.name ?? "";
                } catch {
                  // no extra info — the address is shown instead
                }
                setOffList(true);
                setSelected({
                  mint: preselectMint,
                  symbol,
                  name,
                  liquidityUSD: v.jupiterMetrics?.liquidityUSD ?? 0,
                  liquiditySOL: v.jupiterMetrics?.liquiditySOL ?? 0,
                  marketCapUSD: v.jupiterMetrics?.mcapUSD ?? 0,
                  poolAddress: v.jupiterMetrics?.poolAddress ?? null,
                  tradableAt: null,
                });
              } else {
                setRejection(v?.reason || "It did not pass the safety check.");
              }
            } catch (err: any) {
              if (mounted) {
                setRejection(
                  err?.message || "Couldn't check this token right now."
                );
              }
            } finally {
              if (mounted) setChecking(false);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load buy candidates:", err);
        toast.error("Failed to load tokens.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [preselectMint]);

  useEffect(() => {
    if (connected) refreshBalance();
  }, [connected, refreshBalance]);

  const insufficientBalance = connected && amountSol + FEE_BUFFER_SOL > balance;

  const handleBuy = async () => {
    if (!connected) {
      toast.error("Connect your wallet first.");
      return;
    }
    if (!selected) return;
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      toast.error("Enter a valid SOL amount.");
      return;
    }
    // Checked here (not just left to fail on-chain) so the error is a clear
    // "you don't have enough SOL" instead of an opaque wallet/RPC rejection.
    // Decide on the balance just read, not the one captured when this
    // handler was created (state doesn't update inside a running closure).
    const fresh = await refreshBalance();
    const available = fresh ?? balance;
    if (amountSol + FEE_BUFFER_SOL > available) {
      toast.error(
        `Insufficient balance: you have ${formatNumber(
          available,
          4
        )} SOL, need ~${formatNumber(amountSol + FEE_BUFFER_SOL, 4)} SOL (including network fees).`
      );
      return;
    }

    const lamports = Math.floor(amountSol * 1e9);
    const trade = await executeTrade("buy", selected.mint, lamports);
    if (trade) {
      setSelected(null);
      router.push("/trading");
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={() => router.push("/trading")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-green-400" />
          Buy a Token
        </h1>
      </div>
      <p className="text-sm text-gray-400 -mt-4">
        Only tokens that have already cleared the bot&apos;s own safety checks
        (liquidity, routing, authority) are listed here.
      </p>

      {selected ? (
        <Card className="p-6 space-y-4 bg-base-200 border border-base-300">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">
                {selected.symbol}{" "}
                <span className="text-gray-400 font-normal">
                  {selected.name}
                </span>
              </h2>
              <p className="text-xs text-gray-500 font-mono">
                {truncateAddress(selected.mint)}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setSelected(null);
                setOffList(false);
              }}
            >
              Back to list
            </Button>
          </div>

          {offList && (
            <p className="text-xs text-yellow-400">
              This token isn&apos;t on the bot&apos;s list — it was
              safety-checked just now, and is checked again when you buy.
            </p>
          )}

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="bg-base-300/40 rounded-lg p-3">
              <div className="text-gray-400">Liquidity</div>
              <div className="font-semibold">
                ${formatNumber(selected.liquidityUSD)}
              </div>
            </div>
            <div className="bg-base-300/40 rounded-lg p-3">
              <div className="text-gray-400">Market Cap</div>
              <div className="font-semibold">
                ${formatNumber(selected.marketCapUSD)}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                Amount to spend (SOL)
              </label>
              {connected && (
                <span className="text-xs text-gray-500">
                  Wallet balance: {formatNumber(balance, 4)} SOL
                </span>
              )}
            </div>
            <Input
              type="number"
              min={0}
              step={0.01}
              value={amountSol}
              onChange={(e) => setAmountSol(Number(e.target.value))}
            />
            {insufficientBalance && (
              <p className="text-xs text-red-400">
                Insufficient balance — you have {formatNumber(balance, 4)} SOL,
                need ~{formatNumber(amountSol + FEE_BUFFER_SOL, 4)} SOL
                (including network fees).
              </p>
            )}
          </div>

          <Button
            onClick={handleBuy}
            disabled={submitting || !connected || insufficientBalance}
            className="w-full"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : !connected ? (
              "Connect wallet to buy"
            ) : insufficientBalance ? (
              "Insufficient balance"
            ) : (
              `Buy ${selected.symbol} with ${amountSol} SOL`
            )}
          </Button>
          <p className="text-xs text-gray-500">
            Signed and paid for by your own connected wallet — the tokens land
            in your wallet, not the bot&apos;s.
          </p>
        </Card>
      ) : checking ? (
        <div className="flex items-center gap-2 py-10 justify-center text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          Checking this token&apos;s safety...
        </div>
      ) : rejection ? (
        <Card className="p-6 space-y-3 bg-base-200 border border-red-500/30">
          <h2 className="text-lg font-semibold text-red-400">
            This token didn&apos;t pass the safety check
          </h2>
          <p className="text-sm text-gray-300">{rejection}</p>
          <Button variant="outline" onClick={() => setRejection(null)}>
            Back to list
          </Button>
        </Card>
      ) : loading ? (
        <div className="flex items-center gap-2 py-10 justify-center text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading tradable tokens...
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          No tradable tokens right now — check back shortly.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {candidates.map((c) => (
            <button
              key={c.mint}
              onClick={() => setSelected(c)}
              className="text-left bg-base-200 border border-base-300 rounded-xl p-4 hover:border-primary transition-colors"
            >
              <div className="font-semibold">{c.symbol}</div>
              <div className="text-xs text-gray-400 truncate">{c.name}</div>
              <div className="mt-2 text-xs text-gray-500 flex justify-between">
                <span>Liq ${formatNumber(c.liquidityUSD)}</span>
                <span>MC ${formatNumber(c.marketCapUSD)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BuyPage() {
  return (
    <Suspense fallback={null}>
      <BuyPageInner />
    </Suspense>
  );
}
