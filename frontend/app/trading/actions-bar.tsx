"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  TrendingUp,
  TrendingDown,
  Zap,
  Loader2,
  Ban,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@components/ui/button";
import { useWallet } from "@hooks/useWallet";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useSocket } from "@hooks/useSocket";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { fetcher } from "@lib/utils";
import { signWalletAuth } from "@lib/walletAuth";
import { toast } from "react-hot-toast";
import { motion } from "framer-motion";

export default function ActionsBar() {
  const router = useRouter();
  const { connected, publicKey } = useWallet();
  const { signMessage } = useSolanaWallet();
  const { connected: socketConnected, lastMessage } = useSocket();

  const { config, refetch } = useTraderConfig();

  const [stopping, setStopping] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [globalAutoTradeEnabled, setGlobalAutoTradeEnabled] = useState<
    boolean | null
  >(null);
  const [operatorWallet, setOperatorWallet] = useState<string | null>(null);
  const [globalToggling, setGlobalToggling] = useState(false);

  const refreshGlobalAutoTrade = useCallback(async () => {
    const res = await fetcher<{
      success: boolean;
      enabled?: boolean;
      operatorWallet?: string | null;
      error?: string;
    }>("/api/admin/auto-trade");
    if (!res?.success || typeof res.enabled !== "boolean") {
      throw new Error(res?.error || "Global auto-trade status is unavailable");
    }
    setGlobalAutoTradeEnabled(res.enabled);
    setOperatorWallet(res.operatorWallet ?? null);
  }, []);

  useEffect(() => {
    void refreshGlobalAutoTrade().catch((err: any) => {
      toast.error(err?.message || "Global auto-trade status is unavailable");
      console.error(err);
    });
  }, [refreshGlobalAutoTrade]);

  useEffect(() => {
    if (lastMessage?.event !== "globalAutoTrade:updated") return;
    const enabled = lastMessage.payload?.enabled;
    if (typeof enabled === "boolean") setGlobalAutoTradeEnabled(enabled);
  }, [lastMessage]);

  // Unknown (settings not loaded) is neither paused nor running.
  const autoTradeEnabled: boolean | null = config
    ? (config.globalSettings?.autoTradeEnabled ?? false)
    : null;

  // Pause / resume: flips ONLY the auto-trade switch. Nothing is sold and no
  // other setting changes, and open positions keep being managed by the exit
  // monitor. ("Sell All & Stop" below is the heavy version of this.)
  const handleToggleAutoTrade = useCallback(
    async (enable: boolean) => {
      if (!connected || !publicKey) {
        toast.error("Please connect your wallet first.");
        return;
      }
      setToggling(true);
      try {
        const auth = await signWalletAuth(signMessage, publicKey);
        const res = await fetcher<{
          success: boolean;
          autoTradeEnabled?: boolean;
          error?: string;
        }>(`/api/user-wallet/${publicKey}/auto-trade`, {
          method: "POST",
          body: JSON.stringify({ enabled: enable, ...auth }),
        });
        if (!res?.success) {
          throw new Error(res?.error || "Couldn't change auto-trade");
        }
        void refetch();
        toast.success(
          enable
            ? "Auto-trade resumed."
            : "Auto-trade paused. Nothing was sold — open positions keep being managed."
        );
      } catch (err: any) {
        toast.error(err?.message || "Couldn't change auto-trade");
        console.error(err);
      } finally {
        setToggling(false);
      }
    },
    [connected, publicKey, signMessage, refetch]
  );

  const handleToggleGlobalAutoTrade = useCallback(async () => {
    if (
      !connected ||
      !publicKey ||
      !operatorWallet ||
      publicKey !== operatorWallet
    ) {
      toast.error("Connect the configured operator wallet to change this setting.");
      return;
    }
    const enabled = !globalAutoTradeEnabled;
    setGlobalToggling(true);
    try {
      const auth = await signWalletAuth(signMessage, operatorWallet);
      const res = await fetcher<{
        success: boolean;
        enabled?: boolean;
        error?: string;
      }>("/api/admin/auto-trade", {
        method: "POST",
        body: JSON.stringify({ enabled, ...auth }),
      });
      if (!res?.success || typeof res.enabled !== "boolean") {
        throw new Error(res?.error || "Couldn't change global auto-trade");
      }
      setGlobalAutoTradeEnabled(res.enabled);
      toast.success(
        res.enabled
          ? "Global auto-buys resumed."
          : "Global auto-buys paused. No positions were sold."
      );
    } catch (err: any) {
      toast.error(err?.message || "Couldn't change global auto-trade");
      console.error(err);
    } finally {
      setGlobalToggling(false);
    }
  }, [
    connected,
    publicKey,
    operatorWallet,
    globalAutoTradeEnabled,
    signMessage,
  ]);

  const handleStopAutoTrade = useCallback(async () => {
    if (!connected || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }
    const confirmed = window.confirm(
      "This sells EVERY position the bot has bought for you and turns auto-trading off. The sales cannot be undone. (To just stop new buys without selling anything, use Pause Auto Trade instead.) Continue?"
    );
    if (!confirmed) return;

    setStopping(true);
    toast.loading(
      "Stopping auto-trade and selling bot-bought positions... this can take a few minutes if you hold several.",
      { id: "stop-auto-trade" }
    );
    try {
      const auth = await signWalletAuth(signMessage, publicKey);
      const res = await fetcher<{
        success: boolean;
        disabledAutoTrade: boolean;
        sold: { token: string }[];
        failed: { token: string; error: string }[];
        // Records that still read as open but held nothing (cleared now).
        alreadyClosed?: string[];
        error?: string;
      }>(`/api/user-wallet/${publicKey}/stop-auto-trade`, {
        method: "POST",
        body: JSON.stringify(auth),
        // Sells the positions ONE AFTER ANOTHER within a single request, each
        // a real on-chain swap plus confirmation — so the total grows with
        // how many you hold. The 30s default cut this off mid-way for any
        // wallet with more than a position or two.
        timeoutMs: 300_000,
      });

      if (!res?.success) {
        throw new Error(res?.error || "Failed to stop auto-trade");
      }

      toast.dismiss("stop-auto-trade");
      const cleared = res.alreadyClosed?.length ?? 0;
      if (cleared > 0) {
        toast(
          `Cleared ${cleared} stale position record${cleared === 1 ? "" : "s"} that held nothing.`,
          { duration: 6000 }
        );
      }
      if (res.sold.length === 0 && res.failed.length === 0) {
        toast.success(
          "Auto-trade disabled. You had no bot-bought positions to sell."
        );
      } else if (res.failed.length === 0) {
        toast.success(
          `Auto-trade disabled. Sold ${res.sold.length} position(s).`
        );
      } else {
        // Auto-trade is already off at this point regardless — only the
        // sell-off is partial. List exactly which tokens didn't sell (not
        // just a count) so the user knows what's still open, and that
        // clicking the button again will retry just those.
        const failedList = res.failed
          .map((f) => `${f.token.slice(0, 8)}… (${f.error})`)
          .join("\n");
        toast.success(
          `Auto-trade disabled. Sold ${res.sold.length} position(s).`
        );
        toast.error(
          `${res.failed.length} position(s) failed to sell:\n${failedList}\n\nClick Sell All & Stop again to retry.`,
          { duration: 10000 }
        );
        console.warn("Stop auto-trade: some sells failed", res.failed);
      }
    } catch (err: any) {
      toast.dismiss("stop-auto-trade");
      toast.error(err?.message || "Failed to stop auto-trade");
      console.error(err);
    } finally {
      setStopping(false);
    }
  }, [connected, publicKey, signMessage]);

  return (
    <motion.div
      className="bg-base-200 rounded-xl p-5 flex flex-wrap justify-between items-center gap-4 border border-base-300 shadow-sm"
      initial={{ opacity: 1, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex items-center gap-2 text-primary">
        <Zap size={18} className="text-yellow-400" />
        <h2 className="text-lg font-semibold">Trading Controls</h2>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        {/* Socket status */}
        <span
          className={`text-xs ${
            socketConnected ? "text-green-400" : "text-red-400"
          }`}
        >
          🔌 {socketConnected ? "Live" : "Offline"}
        </span>

        <Button
          variant="secondary"
          disabled={!connected}
          onClick={() => router.push("/trading/buy")}
          className="flex items-center gap-2"
        >
          <TrendingUp />
          Buy
        </Button>

        <Button
          variant="danger"
          disabled={!connected}
          onClick={() => router.push("/trading/sell")}
          className="flex items-center gap-2"
        >
          <TrendingDown />
          Sell
        </Button>

        <Button
          variant="outline"
          disabled={
            !connected || toggling || stopping || autoTradeEnabled === null
          }
          onClick={() => handleToggleAutoTrade(!autoTradeEnabled)}
          className="flex items-center gap-2"
          title={
            autoTradeEnabled
              ? "Stop opening new positions. Nothing is sold; open positions keep being managed."
              : "Start opening positions again"
          }
        >
          {toggling ? (
            <Loader2 className="animate-spin" />
          ) : autoTradeEnabled ? (
            <Pause />
          ) : (
            <Play />
          )}
          {autoTradeEnabled ? "Pause Auto Trade" : "Resume Auto Trade"}
        </Button>

        {connected &&
          publicKey &&
          operatorWallet === publicKey &&
          globalAutoTradeEnabled !== null && (
            <Button
              variant="outline"
              disabled={globalToggling || stopping || toggling}
              onClick={handleToggleGlobalAutoTrade}
              className="flex items-center gap-2"
              title={
                globalAutoTradeEnabled
                  ? "Pause auto-buys for every wallet. Existing positions remain open and managed."
                  : "Resume auto-buys for every wallet."
              }
            >
              {globalToggling ? (
                <Loader2 className="animate-spin" />
              ) : globalAutoTradeEnabled ? (
                <Pause />
              ) : (
                <Play />
              )}
              {globalAutoTradeEnabled
                ? "Pause All Auto-Buys"
                : "Resume All Auto-Buys"}
            </Button>
          )}

        <Button
          variant="outline"
          disabled={!connected || stopping || toggling}
          onClick={handleStopAutoTrade}
          className="flex items-center gap-2"
          title="Sell everything the bot has bought for you and turn off auto-trade"
        >
          {stopping ? <Loader2 className="animate-spin" /> : <Ban />}
          Sell All &amp; Stop
        </Button>
      </div>
    </motion.div>
  );
}
