// frontend/components/trading/token-config-modal.tsx
"use client";

import { useState, useEffect } from "react";
import { useTraderConfig } from "@hooks/useTraderConfig";
import { useTrade } from "@hooks/useTrade";
import { useWallet } from "@hooks/useWallet";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useSolPrice } from "@hooks/useSolPrice";
import { fetcher } from "@lib/utils";
import {
  X,
  Target,
  TrendingUp,
  AlertCircle,
  ShoppingCart,
  TrendingDown,
  Zap,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { EXIT_FILL_NOTE } from "@lib/globalSettings";

interface TokenConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  token: {
    mint: string;
    symbol: string;
    name?: string;
    currentMarketCapSol?: number;
    priceSol?: number;
  };
}

export function TokenConfigModal({
  isOpen,
  onClose,
  token,
}: TokenConfigModalProps) {
  const { config, setTokenConfig, removeTokenConfig, getEffectiveConfig } =
    useTraderConfig();
  const { executeTrade, loading: tradeLoading } = useTrade();
  const { connected } = useWallet();
  const solanaWallet = useSolanaWallet();
  const solPriceUsd = useSolPrice();

  // Use Solana wallet adapter connection status as fallback
  const isWalletConnected = connected || solanaWallet.connected;

  const [formData, setFormData] = useState({
    triggerMarketCapSol: 0,
    takeProfitPct: 10,
    stopLossPct: 30,
    autoTrade: false,
    useCustomConfig: false,
  });

  const [effectiveConfig, setEffectiveConfig] = useState<any>(null);
  const [manualTradeAmountSol, setManualTradeAmountSol] = useState(0.1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen && token.mint) {
      // Load existing token config
      const tokenConfig = config?.tokenSpecificSettings?.[token.mint];
      if (tokenConfig) {
        setFormData({
          triggerMarketCapSol: tokenConfig.triggerMarketCapSol ?? 0,
          takeProfitPct:
            (tokenConfig.takeProfitPct ??
              config?.globalSettings?.takeProfitPct ??
              0.1) * 100,
          stopLossPct:
            (tokenConfig.stopLossPct ??
              config?.globalSettings?.stopLossPct ??
              0.3) * 100,
          autoTrade: tokenConfig.autoTrade ?? false,
          useCustomConfig: true,
        });
      } else {
        setFormData({
          triggerMarketCapSol: token.currentMarketCapSol ?? 0,
          takeProfitPct: (config?.globalSettings?.takeProfitPct ?? 0.1) * 100,
          stopLossPct: (config?.globalSettings?.stopLossPct ?? 0.3) * 100,
          autoTrade: false,
          useCustomConfig: false,
        });
      }

      // Load effective config (what will actually be used)
      let active = true;
      getEffectiveConfig(token.mint).then((cfg: any) => {
        if (!active || !cfg) return;
        setEffectiveConfig(cfg);
        setManualTradeAmountSol(cfg.fixedTradeAmountSol ?? 0.1);
      });
      return () => {
        active = false;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, token.mint, config]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (!formData.useCustomConfig) {
        // Remove custom config, use global defaults
        await removeTokenConfig(token.mint);
      } else {
        // Save custom config
        await setTokenConfig(token.mint, {
          triggerMarketCapSol: formData.triggerMarketCapSol || undefined,
          takeProfitPct: formData.takeProfitPct / 100,
          stopLossPct: formData.stopLossPct / 100,
          autoTrade: formData.autoTrade,
        });
      }
      toast.success("Configuration saved!");
    } catch (err) {
      console.error("Failed to save token config:", err);
      toast.error("Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleTrade = async (type: "buy" | "sell") => {
    console.log(
      "🔵 handleTrade called - type:",
      type,
      "connected:",
      isWalletConnected,
      "tradeLoading:",
      tradeLoading
    );

    if (!isWalletConnected) {
      toast.error("Please connect your wallet first");
      return;
    }

    try {
      // Check if trigger MC condition is met (only for buy)
      if (type === "buy" && formData.triggerMarketCapSol > 0) {
        const currentMC = token.currentMarketCapSol ?? 0;
        console.log(
          "Checking trigger MC:",
          currentMC,
          ">=",
          formData.triggerMarketCapSol
        );
        if (currentMC < formData.triggerMarketCapSol) {
          toast.error(
            `Market cap (${currentMC.toFixed(
              2
            )} SOL) has not reached trigger (${
              formData.triggerMarketCapSol
            } SOL)`
          );
          return;
        }
      }

      // Save config first if custom config is enabled
      if (formData.useCustomConfig) {
        console.log("💾 Saving custom config before trade...");
        await handleSave();
      }

      if (
        type === "buy" &&
        (!Number.isFinite(manualTradeAmountSol) || manualTradeAmountSol <= 0)
      ) {
        toast.error("Enter a positive buy amount in SOL.");
        return;
      }
      let amountLamports: number | string;
      if (type === "buy") {
        amountLamports = Math.floor(manualTradeAmountSol * 1e9);
      } else {
        const walletAddress = solanaWallet.publicKey?.toBase58();
        if (!walletAddress) {
          toast.error("Connect a wallet to check its token balance.");
          return;
        }
        const balance = await fetcher<{
          success: boolean;
          data?: { raw: string };
        }>(
          `/api/trade/token-balance?wallet=${encodeURIComponent(
            walletAddress
          )}&mint=${encodeURIComponent(token.mint)}`
        );
        const rawAmount = balance?.data?.raw;
        if (
          !balance?.success ||
          !rawAmount ||
          !/^\d+$/.test(rawAmount) ||
          /^0+$/.test(rawAmount)
        ) {
          toast.error(`No ${token.symbol} balance to sell.`);
          return;
        }
        amountLamports = rawAmount;
      }

      // Execute the trade
      console.log("🚀 Executing trade:", type, token.mint);
      const result = await executeTrade(type, token.mint, amountLamports);
      console.log("✅ Trade result:", result);

      if (result) {
        toast.success(`${type === "buy" ? "Bought" : "Sold"} ${token.symbol}`);
        onClose();
      }
    } catch (error) {
      console.error("Trade error:", error);
      toast.error(`Failed to execute ${type} trade`);
    }
  };

  const handleAutoTrade = async () => {
    if (!isWalletConnected) {
      toast.error("Please connect your wallet first");
      return;
    }

    // Enable auto-trade in config
    const updatedFormData = { ...formData, autoTrade: true };
    setFormData(updatedFormData);

    setSaving(true);
    try {
      await setTokenConfig(token.mint, {
        triggerMarketCapSol: formData.triggerMarketCapSol || undefined,
        takeProfitPct: formData.takeProfitPct / 100,
        stopLossPct: formData.stopLossPct / 100,
        autoTrade: true,
      });
      toast.success(`Auto-trade enabled for ${token.symbol}`);
      onClose();
    } catch (err) {
      console.error("Failed to enable auto-trade:", err);
      toast.error("Failed to enable auto-trade");
    } finally {
      setSaving(false);
    }
  };

  // Close on Escape and stop the page behind the modal from scrolling while
  // it is open — without the lock, a tall custom-config form scrolls the
  // page underneath instead of the modal body on touch devices.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Debug button states
  console.log("🔍 Modal Button States:", {
    connected: isWalletConnected,
    customWallet: connected,
    solanaWallet: solanaWallet.connected,
    saving,
    tradeLoading,
    buyDisabled: saving || tradeLoading || !isWalletConnected,
    sellDisabled: saving || tradeLoading || !isWalletConnected,
    autoTradeDisabled: saving || tradeLoading || !isWalletConnected,
  });

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-3 sm:p-4"
      onClick={(e) => {
        // Close if clicking the backdrop
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-config-title"
        className="bg-gray-900 border border-gray-800 rounded-lg max-w-lg w-full shadow-2xl flex flex-col max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Wallet Not Connected Warning */}
        {!isWalletConnected && (
          <div className="shrink-0 bg-yellow-900/30 border-b border-yellow-700/50 p-3 sm:p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-yellow-200 font-semibold text-sm">
                Wallet Not Connected
              </p>
              <p className="text-yellow-300/80 text-xs mt-1">
                Please connect your wallet to enable Buy, Sell, and Auto-Trade
                buttons. Look for the &quot;Connect Wallet&quot; button in the
                top navigation.
              </p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-3 p-4 sm:p-6 border-b border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <Target className="w-6 h-6 text-purple-400 shrink-0" />
            <div className="min-w-0">
              <h2
                id="token-config-title"
                className="text-lg sm:text-xl font-bold text-white"
              >
                Configure Trade
              </h2>
              <p className="text-sm text-gray-400 truncate">{token.symbol}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 -m-2 p-2 text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6 space-y-5 sm:space-y-6">
          {/* Current Info */}
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400">Current MC</p>
                <p className="text-white font-semibold">
                  {token.currentMarketCapSol?.toFixed(2) ?? "N/A"} SOL
                </p>
                {solPriceUsd != null && (
                  <p className="text-xs text-gray-500">
                    ~$
                    {(
                      (token.currentMarketCapSol ?? 0) * solPriceUsd
                    ).toLocaleString()}
                  </p>
                )}
              </div>
              <div>
                <p className="text-gray-400">Current Price</p>
                <p className="text-white font-semibold">
                  {token.priceSol?.toFixed(6) ?? "N/A"} SOL
                </p>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Buy amount (SOL)
            </label>
            <input
              type="number"
              value={manualTradeAmountSol}
              onChange={(e) =>
                setManualTradeAmountSol(Number(e.target.value))
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
              min="0"
              step="0.001"
            />
            <p className="text-xs text-gray-500 mt-1">
              Defaults to your fixed trade size when configured; otherwise
              enter the amount for this manual buy.
            </p>
          </div>

          {/* Use Custom Config Toggle */}
          <div className="flex items-center justify-between gap-3 bg-blue-900/20 border border-blue-800 rounded-lg p-4">
            <div className="min-w-0">
              <p className="text-white font-medium">Custom Configuration</p>
              <p className="text-sm text-gray-400">
                Override global settings for this token
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setFormData({
                  ...formData,
                  useCustomConfig: !formData.useCustomConfig,
                })
              }
              role="switch"
              aria-checked={formData.useCustomConfig}
              aria-label="Use custom configuration for this token"
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-gray-900 ${
                formData.useCustomConfig ? "bg-primary" : "bg-gray-700"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  formData.useCustomConfig ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {formData.useCustomConfig && (
            <>
              {/* Trigger Market Cap */}
              <div>
                <div className="flex items-start gap-2 mb-2">
                  <TrendingUp className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  <label className="text-sm font-medium text-gray-300">
                    Trigger Market Cap (SOL) - Optional
                  </label>
                </div>
                <input
                  type="number"
                  value={formData.triggerMarketCapSol}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      triggerMarketCapSol: Number(e.target.value),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                  placeholder="Enter MC to trigger trade"
                  min="0"
                  step="1"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Trade will trigger when MC reaches this value. Leave 0 to
                  trade immediately.
                </p>
                {formData.triggerMarketCapSol > 0 && solPriceUsd != null && (
                  <p className="text-xs text-blue-400 mt-1">
                    ~$
                    {(
                      formData.triggerMarketCapSol * solPriceUsd
                    ).toLocaleString()}
                  </p>
                )}
              </div>

              {/* TP/SL */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Take Profit (%)
                  </label>
                  <input
                    type="number"
                    value={formData.takeProfitPct}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        takeProfitPct: Number(e.target.value),
                      })
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    step="1"
                  />
                  <p className="text-xs text-green-500 mt-1">
                    Exit at +{formData.takeProfitPct}%
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Stop Loss (%)
                  </label>
                  <input
                    type="number"
                    value={formData.stopLossPct}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        stopLossPct: Number(e.target.value),
                      })
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-blue-500"
                    min="0"
                    step="0.5"
                  />
                  <p className="text-xs text-red-500 mt-1">
                    Exit at -{formData.stopLossPct}%
                  </p>
                </div>
              </div>
              <p className="text-xs text-gray-500">{EXIT_FILL_NOTE}</p>

              {/* Auto Trade */}
              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.autoTrade}
                    onChange={(e) =>
                      setFormData({ ...formData, autoTrade: e.target.checked })
                    }
                    className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-blue-500 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-300">
                    Enable auto-trade for this token
                  </span>
                </label>
              </div>
            </>
          )}

          {/* Effective Config Preview */}
          {effectiveConfig && (
            <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-blue-400" />
                <p className="text-sm font-medium text-gray-300">
                  {formData.useCustomConfig
                    ? "Will Use Custom Settings"
                    : "Will Use Global Settings"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
                <div>
                  TP:{" "}
                  {formData.useCustomConfig
                    ? formData.takeProfitPct
                    : (effectiveConfig.takeProfitPct * 100).toFixed(1)}
                  %
                </div>
                <div>
                  SL:{" "}
                  {formData.useCustomConfig
                    ? formData.stopLossPct
                    : (effectiveConfig.stopLossPct * 100).toFixed(1)}
                  %
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex flex-col gap-3 p-4 sm:p-6 border-t border-gray-800 bg-gray-800/50">
          {/* Trade Action Buttons */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={(e) => {
                console.log("🟢 BUY button clicked!", e);
                e.preventDefault();
                e.stopPropagation();
                handleTrade("buy");
              }}
              disabled={saving || tradeLoading || !isWalletConnected}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <ShoppingCart className="w-4 h-4" />
              {tradeLoading ? "Buying..." : "Buy Now"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                console.log("🔴 SELL button clicked!", e);
                e.preventDefault();
                e.stopPropagation();
                handleTrade("sell");
              }}
              disabled={saving || tradeLoading || !isWalletConnected}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <TrendingDown className="w-4 h-4" />
              {tradeLoading ? "Selling..." : "Sell Now"}
            </button>
          </div>

          {/* Auto-Trade & Save Buttons — auto-trade spans the full width on
              phones, Save/Close share the row below it */}
          <div className="grid grid-cols-2 sm:flex sm:items-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                console.log("⚡ AUTO-TRADE button clicked!", e);
                e.preventDefault();
                e.stopPropagation();
                handleAutoTrade();
              }}
              disabled={saving || tradeLoading || !isWalletConnected}
              className="col-span-2 sm:col-span-1 sm:flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary-hover text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Zap className="w-4 h-4" />
              {saving ? "Enabling..." : "Enable Auto-Trade"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                console.log("💾 SAVE button clicked!", e);
                e.preventDefault();
                e.stopPropagation();
                handleSave();
              }}
              disabled={saving || tradeLoading}
              className="px-4 sm:px-6 py-3 bg-base-300 hover:bg-base-300/70 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
            >
              {saving ? "Saving..." : "Save Config"}
            </button>

            <button
              type="button"
              onClick={(e) => {
                console.log("❌ CLOSE button clicked!", e);
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
              className="px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={saving || tradeLoading}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
