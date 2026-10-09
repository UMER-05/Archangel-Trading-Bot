// frontend/hooks/useConfig.ts
import { create } from "zustand";
import { fetcher } from "@lib/utils";
import { signWalletAuth, SignMessageFn } from "@lib/walletAuth";

interface TradingConfig {
  autoTrade: boolean;
  selectedToken?: string;
  setSelectedToken: (token: string) => void;
  setAutoTrade: (value: boolean) => void;
  saveConfig: (wallet?: string) => void;
  loadConfig: (wallet?: string) => void;
  syncConfig: (
    wallet: string,
    signMessage: SignMessageFn | undefined
  ) => Promise<void>;
  loadConfigFromAPI: (wallet: string) => Promise<void>;
}

export const useTradingConfigStore = create<TradingConfig>((set, get) => ({
  autoTrade: false,
  selectedToken: undefined, // No default - user must select from discovered tokens

  setAutoTrade: (value) => set({ autoTrade: value }),
  setSelectedToken: (token: string) => set({ selectedToken: token }),

  // Keyed per-wallet — without this, Wallet A's saved preferences would
  // still be sitting in localStorage under a flat key and show up
  // immediately for Wallet B on the same browser, before (or even if)
  // loadConfigFromAPI ever gets a chance to overwrite them with B's own.
  saveConfig: (wallet) => {
    const config = get();
    localStorage.setItem(
      `tradingConfig:${wallet || "anonymous"}`,
      JSON.stringify(config)
    );
    console.log("✅ Trading config saved locally:", config);
  },

  loadConfig: (wallet) => {
    const saved = localStorage.getItem(
      `tradingConfig:${wallet || "anonymous"}`
    );
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Migration: Clear old BONK default
        if (parsed.selectedToken === "BONK") {
          parsed.selectedToken = undefined;
        }
        set(parsed);
        console.log("🔁 Loaded saved trading config:", parsed);
      } catch (err) {
        console.error("⚠️ Failed to parse saved config:", err);
      }
    } else {
      // No cached config for this wallet — reset to defaults rather than
      // leaving whatever the PREVIOUSLY connected wallet's values were
      // sitting in the live store.
      set({
        autoTrade: false,
        selectedToken: undefined,
      });
    }
  },

  // Persist the data fields (not the store's functions) to the backend for
  // this wallet — real persistence now, see db.service.ts's userSettings
  // collection / user.route.ts. Signed so the backend can verify this
  // actually came from whoever controls `wallet`, not just trust the field —
  // otherwise anyone could overwrite any other wallet's saved settings by
  // POSTing a different wallet address.
  syncConfig: async (
    wallet: string,
    signMessage: SignMessageFn | undefined
  ) => {
    if (!wallet) {
      console.warn("⚠️ No wallet provided to sync config");
      return;
    }
    try {
      const auth = await signWalletAuth(signMessage, wallet);
      const { autoTrade, selectedToken } = get();
      await fetcher("/api/user/settings", {
        method: "POST",
        body: JSON.stringify({
          wallet,
          autoTrade,
          selectedToken,
          ...auth,
        }),
      });
      console.log("☁️ Synced config to backend");
    } catch (err) {
      console.error("❌ Config sync failed:", err);
    }
  },

  // Load this wallet's saved settings from the backend
  loadConfigFromAPI: async (wallet: string) => {
    try {
      if (!wallet) {
        console.warn("⚠️ No wallet provided to load config");
        return;
      }
      const data = await fetcher<any>(`/api/user/settings?wallet=${wallet}`);
      if (data.success && data.data) {
        const { autoTrade, selectedToken } = data.data;
        set({
          ...(autoTrade != null && { autoTrade }),
          ...(selectedToken != null && { selectedToken }),
        });
        console.log("☁️ Loaded config from backend:", data.data);
      }
    } catch (err) {
      console.error("⚠️ Failed to load config from backend:", err);
    }
  },
}));

// Export alias for convenience
export const useConfig = useTradingConfigStore;
