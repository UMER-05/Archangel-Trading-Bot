"use client";

import React, { useCallback, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import type { WalletError } from "@solana/wallet-adapter-base";
import { toast } from "react-hot-toast";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";

// Import wallet adapter CSS
import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Use mainnet-beta
  const network = WalletAdapterNetwork.Mainnet;

  // Use custom RPC or fallback to public
  const endpoint = useMemo(
    () =>
      process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      clusterApiUrl(network),
    [network]
  );

  // Phantom and Solflare both now self-register via the browser's Wallet
  // Standard, independent of this app — manually instantiating
  // PhantomWalletAdapter/SolflareWalletAdapter here created a SECOND,
  // competing registration of the same wallet, which is what was actually
  // causing connect() to hang forever on "Connecting..." (confirmed via
  // Phantom's own console warning: "Phantom was registered as a Standard
  // Wallet. The Wallet Adapter for Phantom can be removed from your app.",
  // plus ObjectMultiplex "orphaned data" stream errors from the two
  // instances fighting over the same extension). An empty array is the
  // current recommended pattern — @solana/wallet-adapter-react auto-detects
  // every Standard Wallet the browser has injected.
  const wallets = useMemo(() => [], []);

  // WITHOUT this, a failed connection is swallowed: the library only logs it
  // to the console, and — this is the part that produces "stuck on
  // Connecting..." — a FAILED autoConnect on page load (the classic cause is
  // the site's permission having been revoked or the extension reinstalled,
  // while this browser still remembers a wallet name to reconnect to) can
  // leave that stale wallet name in place, so the very next click just
  // retries the same broken autoConnect instead of opening the picker fresh.
  // This surfaces the error and clears that stale name so the next click
  // starts clean. It also means unrelated causes (locked extension, multiple
  // conflicting wallet extensions, an old cached build) now show a toast
  // instead of a silent hang — narrowing down which one it actually is.
  const onError = useCallback((error: WalletError) => {
    console.error("Wallet error:", error);
    toast.error(
      error?.message
        ? `Wallet: ${error.message}`
        : "Couldn't connect to your wallet — try again, or reload the page."
    );
    try {
      window.localStorage.removeItem("walletName");
    } catch {
      // localStorage unavailable — nothing more to do
    }
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
