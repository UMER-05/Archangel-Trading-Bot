"use client";

import {
  useWalletData,
  type WalletState,
} from "@app/providers/WalletDataProvider";

export type { WalletState };

/**
 * The connected wallet's address, SOL balance and connect/disconnect helpers.
 *
 * A thin reader of WalletDataProvider (mounted once in app/layout.tsx). The
 * balance polling, wallet provisioning and socket identify that this hook
 * used to perform in every component that called it now run exactly once, in
 * the provider — so calling useWallet() from as many components as you like
 * costs nothing.
 */
export const useWallet = (): WalletState => useWalletData();
