// frontend/hooks/useTraderConfig.ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { socket } from "@lib/socket";
import { useWallet } from "./useWallet";
import { ENV } from "@lib/constant";
import { signWalletAuth } from "@lib/walletAuth";
import { callConfigApi } from "@lib/configApi";

export interface TraderConfig {
  walletAddress: string;
  globalSettings: {
    minMarketCapSol?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    minSecondsSinceLaunch?: number;
    minTokenScore?: number;
    autoTradeEnabled?: boolean;
    // How many positions the bot may hold at once; the trading wallet's
    // balance is split across them. A count, not a SOL amount.
    maxOpenPositions?: number;
    // The most SOL the bot may have at work; anything beyond it in the trading
    // wallet is protected. null/absent = no budget. tradingBudgetSetAt is
    // stamped by the server (only losses after it lower the budget's capital).
    tradingBudgetSol?: number | null;
    tradingBudgetSetAt?: number;
    // null explicitly clears a previously-set cap (unlimited); undefined
    // just means "not included in this update".
    maxTotalTrades?: number | null;
    fixedTradeAmountSol?: number | null;
    slippageBps?: number;
    priorityFeeSol?: number;
    maxDailyLossPct?: number;
    maxRiskPerTradePct?: number;
  };
  tokenSpecificSettings: {
    [mint: string]: {
      minMarketCapSol?: number;
      takeProfitPct?: number;
      stopLossPct?: number;
      entryPriceSol?: number;
      triggerMarketCapSol?: number;
      autoTrade?: boolean;
    };
  };
  createdAt: Date;
  updatedAt: Date;
  // How many trades this wallet has taken so far — added by the GET route
  // alongside the stored config, not itself a stored field.
  tradesTaken?: number;
}

export function useTraderConfig() {
  const { publicKey } = useWallet();
  const { signMessage } = useSolanaWallet();
  const [config, setConfig] = useState<TraderConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The wallet this hook instance is currently serving; lets an in-flight
  // response for a previous wallet be dropped instead of overwriting the new
  // wallet's config.
  const activeWallet = useRef<string | null>(null);

  const applyConfig = useCallback((next: TraderConfig) => {
    // Write responses and socket broadcasts carry the stored config only;
    // `tradesTaken` is added by the GET route. Keep the last known value
    // rather than letting every save/broadcast erase it.
    setConfig((prev) => ({
      ...next,
      tradesTaken: next.tradesTaken ?? prev?.tradesTaken,
    }));
  }, []);

  /** Re-reads the saved config. Resolves true on success. */
  const fetchConfig = useCallback(async (): Promise<boolean> => {
    const wallet = activeWallet.current;
    if (!wallet) return false;
    try {
      const data = await callConfigApi(
        `${ENV.API_BASE_URL}/trader-config/${wallet}`
      );
      if (activeWallet.current !== wallet) return false;
      applyConfig(data.config);
      setLoadError(null);
      return true;
    } catch (err: any) {
      if (activeWallet.current !== wallet) return false;
      console.error("Failed to fetch trader config:", err);
      setLoadError(err?.message || "Couldn't load your saved settings.");
      return false;
    }
  }, [applyConfig]);

  // Fetch config when wallet connects
  useEffect(() => {
    activeWallet.current = publicKey;
    setConfig(null);
    setLoadError(null);
    if (!publicKey) {
      setLoading(false);
      return;
    }

    const walletAddress = publicKey;
    setLoading(true);
    fetchConfig().finally(() => {
      if (activeWallet.current === walletAddress) setLoading(false);
    });

    // Listen for real-time config updates
    const handleConfigUpdate = (updated: TraderConfig) => {
      if (updated.walletAddress === walletAddress) {
        applyConfig(updated);
      }
    };
    socket.on("traderConfig:updated", handleConfigUpdate);

    return () => {
      socket.off("traderConfig:updated", handleConfigUpdate);
    };
  }, [publicKey, fetchConfig, applyConfig]);

  const requireWallet = (): string => {
    if (!publicKey) throw new Error("Connect your wallet first.");
    return publicKey;
  };

  // Write operations THROW on failure (bad signature, rejected by the server,
  // network down). They used to swallow the error and return null, which every
  // caller ignored — so a rejected save closed the dialog and looked done.

  /** Update global settings (requires a wallet signature). */
  const updateGlobalSettings = async (
    settings: TraderConfig["globalSettings"]
  ): Promise<TraderConfig> => {
    const walletAddress = requireWallet();
    const auth = await signWalletAuth(signMessage, walletAddress);
    const data = await callConfigApi(
      `${ENV.API_BASE_URL}/trader-config/${walletAddress}/global`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, ...auth }),
      }
    );
    applyConfig(data.config);
    return data.config;
  };

  /** Set token-specific configuration (requires a wallet signature). */
  const setTokenConfig = async (
    mint: string,
    tokenConfig: TraderConfig["tokenSpecificSettings"][string]
  ): Promise<TraderConfig> => {
    const walletAddress = requireWallet();
    const auth = await signWalletAuth(signMessage, walletAddress);
    const data = await callConfigApi(
      `${ENV.API_BASE_URL}/trader-config/${walletAddress}/token/${mint}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tokenConfig, ...auth }),
      }
    );
    applyConfig(data.config);
    return data.config;
  };

  /**
   * Remove token-specific configuration (requires a wallet signature).
   * Resolves null when there was nothing to remove.
   */
  const removeTokenConfig = async (
    mint: string
  ): Promise<TraderConfig | null> => {
    const walletAddress = requireWallet();
    const auth = await signWalletAuth(signMessage, walletAddress);
    const qs = new URLSearchParams({
      walletAuthTimestamp: String(auth.walletAuthTimestamp),
      walletAuthSignature: auth.walletAuthSignature,
    }).toString();
    try {
      const data = await callConfigApi(
        `${ENV.API_BASE_URL}/trader-config/${walletAddress}/token/${mint}?${qs}`,
        { method: "DELETE" }
      );
      applyConfig(data.config);
      return data.config;
    } catch (err: any) {
      // 404 = no custom config existed; "reset to defaults" is already true.
      if (err?.status === 404) return null;
      throw err;
    }
  };

  /** Get effective configuration for a token (token > global > defaults). */
  const getEffectiveConfig = async (mint: string) => {
    if (!publicKey) return null;
    try {
      const data = await callConfigApi(
        `${ENV.API_BASE_URL}/trader-config/${publicKey}/effective/${mint}`
      );
      return data.config;
    } catch (err) {
      console.error("Failed to get effective config:", err);
      return null;
    }
  };

  return {
    config,
    loading,
    loadError,
    refetch: fetchConfig,
    updateGlobalSettings,
    setTokenConfig,
    removeTokenConfig,
    getEffectiveConfig,
  };
}
