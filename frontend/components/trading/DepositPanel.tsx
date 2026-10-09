// frontend/components/trading/DepositPanel.tsx
"use client";

import React, { useState } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import {
  Copy,
  Check,
  Loader2,
  Wallet,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { Card } from "@components/ui/card";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { useUserWallet } from "@hooks/useUserWallet";
import { copyText } from "@lib/clipboard";
import { fetcher } from "@lib/utils";
import { signWalletAuth } from "@lib/walletAuth";

export function DepositPanel() {
  const { connected, publicKey, signMessage } = useSolanaWallet();
  const {
    hotWalletPublicKey,
    balanceSol,
    openPositions,
    feeReserveSol,
    tradingBudgetSol,
    tradingCapitalSol,
    protectedProfitSol,
    loading,
    error,
    refresh,
  } = useUserWallet();
  const [copied, setCopied] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  const handleCopy = async () => {
    if (!hotWalletPublicKey) return;
    if (await copyText(hotWalletPublicKey)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Couldn't copy — select the address and copy it manually.");
    }
  };

  // While the bot holds open positions it needs SOL in this wallet to pay the
  // fees to sell them; withdrawing that last bit strands the positions.
  const requestedSol = Number(withdrawAmount);
  const leavesTooLittle =
    (openPositions ?? 0) > 0 &&
    feeReserveSol != null &&
    balanceSol != null &&
    Number.isFinite(requestedSol) &&
    requestedSol > 0 &&
    balanceSol - requestedSol < feeReserveSol;

  // With a trading budget on, everything beyond the capital the bot may use is
  // "protected profit": it can be withdrawn without touching what the bot
  // trades with. Withdrawing MORE than that cuts into the budget itself.
  const budgetOn = tradingBudgetSol != null;
  const protectedSol = protectedProfitSol ?? 0;
  const withdrawableProfit = Math.floor(protectedSol * 10000) / 10000;
  const dipsIntoBudget =
    budgetOn &&
    Number.isFinite(requestedSol) &&
    requestedSol > 0 &&
    requestedSol > protectedSol + 1e-9;
  const handleWithdraw = async () => {
    const amountSol = Number(withdrawAmount);
    if (!publicKey || !Number.isFinite(amountSol) || amountSol <= 0) {
      toast.error("Enter a valid amount to withdraw");
      return;
    }
    setWithdrawing(true);
    try {
      const wallet = publicKey.toBase58();
      const auth = await signWalletAuth(signMessage, wallet);
      const res = await fetcher<{ success: boolean; signature: string }>(
        `/api/user-wallet/${wallet}/withdraw`,
        {
          method: "POST",
          body: JSON.stringify({ amountSol, ...auth }),
        }
      );
      if (res?.success) {
        toast.success(`Withdrew ${amountSol} SOL to your wallet`);
        setWithdrawAmount("");
        await refresh();
      }
    } catch (err: any) {
      toast.error(err?.message || "Withdrawal failed");
    } finally {
      setWithdrawing(false);
    }
  };

  if (!connected) {
    return (
      <Card className="bg-base-200 border border-white/[0.07] rounded-2xl p-6">
        <div className="flex items-center gap-3">
          <Wallet className="w-5 h-5 text-base-content/40" />
          <div>
            <h2 className="font-display text-lg font-semibold text-white">
              Trading Wallet
            </h2>
            <p className="text-sm text-base-content/50 mt-1">
              Connect your wallet to get your dedicated trading wallet address.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-base-200 border border-white/[0.07] rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="w-5 h-5 text-primary" />
          <div>
            <h2 className="font-display text-lg font-semibold text-white">
              Trading Wallet
            </h2>
            <p className="text-sm text-base-content/50 mt-1">
              The bot trades with funds sent here — not your connected wallet
              directly.
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={loading}
          title="Refresh balance"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : loading && !hotWalletPublicKey ? (
        <div className="flex items-center gap-2 text-sm text-base-content/50">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your trading
          wallet...
        </div>
      ) : hotWalletPublicKey ? (
        <>
          <div>
            <label className="text-xs uppercase tracking-wide text-base-content/40">
              Deposit address
            </label>
            <div className="mt-1 flex items-center gap-2 bg-base-300 rounded-lg px-4 py-3 font-mono text-sm text-white break-all">
              <span className="flex-1">{hotWalletPublicKey}</span>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 text-base-content/50 hover:text-white transition-colors"
                title="Copy address"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between p-3 bg-base-300 rounded-lg">
            <span className="text-sm text-base-content/50">Balance</span>
            <span className="text-lg font-bold text-primary">
              {(balanceSol ?? 0).toFixed(4)} SOL
            </span>
          </div>

          {budgetOn && (
            <div className="p-3 bg-green-900/10 border border-green-500/20 rounded-lg space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-base-content/60">
                  Protected profit
                </span>
                <span className="text-lg font-bold text-green-400">
                  {protectedSol.toFixed(4)} SOL
                </span>
              </div>
              <p className="text-xs text-base-content/40">
                Trading budget {tradingBudgetSol} SOL
                {tradingCapitalSol != null &&
                tradingCapitalSol < (tradingBudgetSol ?? 0)
                  ? ` (capital ${tradingCapitalSol.toFixed(4)} SOL after losses)`
                  : ""}
                . Anything beyond it stays in this wallet but the bot never
                trades it — you can withdraw it whenever you like.
              </p>
              {withdrawableProfit > 0 && (
                <button
                  type="button"
                  onClick={() => setWithdrawAmount(String(withdrawableProfit))}
                  className="text-xs text-green-400 hover:underline"
                >
                  Fill in the protected profit ({withdrawableProfit} SOL)
                </button>
              )}
            </div>
          )}

          <p className="text-xs text-base-content/40">
            Send SOL to this address from any wallet to fund auto-trading. Only
            you can withdraw it back out.
            {budgetOn
              ? " With a trading budget on, SOL you add later isn't traded until you raise the budget."
              : ""}
          </p>

          <div className="pt-2 border-t border-white/[0.07] space-y-2">
            <label className="text-xs uppercase tracking-wide text-base-content/40">
              Withdraw to your connected wallet
            </label>
            <div className="flex gap-2">
              <Input
                type="number"
                min="0"
                step="0.001"
                placeholder="0.00"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                disabled={withdrawing}
              />
              <Button
                variant="secondary"
                onClick={handleWithdraw}
                disabled={withdrawing || !withdrawAmount}
              >
                {withdrawing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowUpRight className="w-4 h-4" />
                )}
                Withdraw
              </Button>
            </div>
            {dipsIntoBudget && (
              <p className="text-xs text-yellow-400">
                That&apos;s more than your protected profit (
                {protectedSol.toFixed(4)} SOL), so it cuts into the trading
                budget — the bot will have less to trade with.
              </p>
            )}
            {leavesTooLittle && (
              <p className="text-xs text-yellow-400">
                The bot has {openPositions} open position
                {openPositions === 1 ? "" : "s"} and needs about {feeReserveSol}{" "}
                SOL left here to pay the fees to sell{" "}
                {openPositions === 1 ? "it" : "them"}. Withdrawing this much
                could leave {openPositions === 1 ? "it" : "them"} unable to
                exit.
              </p>
            )}
            <p className="text-xs text-base-content/40">
              Sends to {publicKey?.toBase58().slice(0, 4)}...
              {publicKey?.toBase58().slice(-4)} — your connected wallet, no
              other address is possible.
            </p>
          </div>
        </>
      ) : null}
    </Card>
  );
}

export default DepositPanel;
