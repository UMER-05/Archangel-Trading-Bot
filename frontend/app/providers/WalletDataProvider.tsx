// app/providers/WalletDataProvider.tsx
"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import { socket } from "@lib/socket";
import { fetcher } from "@lib/utils";
import { signWalletAuth } from "@lib/walletAuth";
import {
  clearSocketToken,
  readSocketToken,
  writeSocketToken,
} from "@lib/socketSession";

// The connected wallet's state, computed ONCE for the whole app.
//
// This used to live in the useWallet() hook itself, so every component that
// called it (a dozen of them, including useTraderConfig) started its own
// 10-second RPC balance poll, its own wallet-provisioning request and its own
// socket "identify" — twelve times over on every page, which tripped RPC rate
// limits and spammed the server. Now the provider runs those effects once and
// useWallet() just reads the result.

export interface WalletState {
  connected: boolean;
  publicKey: string | null;
  balance: number;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  // Resolves the freshly read balance (SOL), or null if it couldn't be read —
  // so a caller that must decide RIGHT NOW (e.g. "can I afford this buy?")
  // doesn't have to trust the state it captured before the refresh.
  refreshBalance: () => Promise<number | null>;
}

const noop = async () => {};
const WalletDataContext = createContext<WalletState>({
  connected: false,
  publicKey: null,
  balance: 0,
  connectWallet: noop,
  disconnectWallet: noop,
  refreshBalance: async () => null,
});

const BALANCE_POLL_MS = 10_000;

function rpcEndpoints(): string[] {
  return [
    process.env.NEXT_PUBLIC_SOLANA_ENDPOINT,
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    process.env.NEXT_PUBLIC_SOLANA_FALLBACK_1,
    process.env.NEXT_PUBLIC_SOLANA_FALLBACK_2,
    "https://api.mainnet-beta.solana.com",
  ].filter((u): u is string => Boolean(u));
}

export const WalletDataProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const solanaWallet = useSolanaWallet();
  const [balance, setBalance] = useState(0);

  const connected = solanaWallet.connected;
  const publicKey = solanaWallet.publicKey?.toString() || null;
  const { signMessage } = solanaWallet;

  // One Connection per endpoint, reused across polls.
  const connections = useMemo(
    () => rpcEndpoints().map((url) => new Connection(url, "confirmed")),
    []
  );

  const connectWallet = useCallback(async () => {
    try {
      // Opens the wallet selection modal if no wallet is chosen yet.
      await solanaWallet.connect();
    } catch (err) {
      console.error("❌ Wallet connection failed:", err);
      if (err instanceof Error && !err.message.includes("User rejected")) {
        alert(
          "No wallet detected. Please install Phantom or Solflare wallet extension and refresh the page."
        );
      }
    }
  }, [solanaWallet]);

  const disconnectWallet = useCallback(async () => {
    try {
      await solanaWallet.disconnect();
      setBalance(0);
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  }, [solanaWallet]);

  const refreshBalance = useCallback(async (): Promise<number | null> => {
    const owner = solanaWallet.publicKey;
    if (!owner || !solanaWallet.connected) return null;

    let lastError: unknown = null;
    for (const connection of connections) {
      try {
        const lamports = await connection.getBalance(owner);
        const sol = lamports / 1e9;
        setBalance(sol);
        return sol;
      } catch (err) {
        lastError = err; // rate-limited or down: try the next endpoint
      }
    }
    console.error("❌ Failed to refresh balance on all endpoints:", lastError);
    // Keep the last known balance rather than showing 0 for a blip.
    return null;
  }, [solanaWallet.publicKey, solanaWallet.connected, connections]);

  // Balance: refresh on connect, then poll — once for the whole app.
  useEffect(() => {
    if (!connected || !publicKey) return;
    void refreshBalance();
    const id = setInterval(() => void refreshBalance(), BALANCE_POLL_MS);
    return () => clearInterval(id);
  }, [connected, publicKey, refreshBalance]);

  // "Sign up" the wallet: generates its custodial trading wallet on first
  // sight (idempotent), so connecting anywhere in the app makes a real user.
  useEffect(() => {
    if (!connected || !publicKey) return;
    fetcher(`/api/user-wallet/${publicKey}`).catch((err) =>
      console.error("Failed to provision trading wallet:", err)
    );
  }, [connected, publicKey]);

  // Live updates: tell the server which wallet's private events this socket
  // should receive. The server requires PROOF of the wallet (a signed message,
  // or a session token from an earlier proof) — so the first identify in a
  // tab asks the wallet to sign once, and reconnects reuse the token.
  useEffect(() => {
    if (!connected || !publicKey) return;
    const wallet = publicKey;
    let cancelled = false;
    let signing = false;

    const identifyWithSignature = async () => {
      if (signing) return;
      if (!signMessage) {
        console.warn(
          "This wallet can't sign messages, so live account updates are unavailable."
        );
        return;
      }
      signing = true;
      try {
        const auth = await signWalletAuth(signMessage, wallet);
        if (!cancelled) socket.emit("identify", { wallet, ...auth });
      } catch (err) {
        console.warn(
          "Wallet signature for live updates was not provided:",
          err
        );
      } finally {
        signing = false;
      }
    };

    const identify = () => {
      const token = readSocketToken(wallet);
      if (token) socket.emit("identify", { wallet, token });
      else void identifyWithSignature();
    };

    const onIdentified = (msg: {
      wallet?: string;
      success?: boolean;
      token?: string;
      expiresAt?: number;
      error?: string;
    }) => {
      if (msg?.success) {
        if (msg.token && typeof msg.expiresAt === "number") {
          writeSocketToken(wallet, msg.token, msg.expiresAt);
        }
        return;
      }
      // Rejected. A stale token (e.g. the server restarted) is dropped and
      // replaced by one fresh signature; a rejected signature is not retried.
      if (readSocketToken(wallet)) {
        clearSocketToken(wallet);
        void identifyWithSignature();
      } else {
        console.warn("Live account updates unavailable:", msg?.error);
      }
    };

    socket.on("identified", onIdentified);
    socket.on("connect", identify);
    if (socket.connected) identify();

    return () => {
      cancelled = true;
      socket.off("identified", onIdentified);
      socket.off("connect", identify);
    };
  }, [connected, publicKey, signMessage]);

  const value = useMemo<WalletState>(
    () => ({
      connected,
      publicKey,
      balance,
      connectWallet,
      disconnectWallet,
      refreshBalance,
    }),
    [
      connected,
      publicKey,
      balance,
      connectWallet,
      disconnectWallet,
      refreshBalance,
    ]
  );

  return (
    <WalletDataContext.Provider value={value}>
      {children}
    </WalletDataContext.Provider>
  );
};

export const useWalletData = (): WalletState => useContext(WalletDataContext);
