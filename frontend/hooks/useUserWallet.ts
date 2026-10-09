// frontend/hooks/useUserWallet.ts
"use client";

import { useCallback } from "react";
import useSWR from "swr";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { fetcher } from "@lib/utils";

interface UserWalletResponse {
  success: boolean;
  hotWalletPublicKey: string;
  balanceSol: number;
  // The balance at which every one of the trader's position slots could be
  // opened at the minimum size (fee reserve + slots x minimum).
  minBalanceForAutoTradeSol: number;
  // How many positions the trader allows at once, and how many the bot holds
  // right now. Optional so an older backend that predates them still works.
  maxOpenPositions?: number;
  openPositions?: number;
  // Sizing floors: the smallest position the bot will open, and the SOL it
  // keeps back for network fees / token-account rent.
  minTradeSol?: number;
  feeReserveSol?: number;
  // Server-side safety limits that can also stop new buys: today's loss
  // against the daily limit (percent of the wallet's value), and the optional
  // global position cap from the server's .env (0 = none).
  dailyLossPct?: number;
  maxDailyLossPct?: number;
  serverMaxOpenPositions?: number;
  // Trading budget (null = off). capital = budget less losses realized since it
  // was set; deployed = SOL at work in open positions; protectedProfit = cash
  // beyond the capital the bot may use (withdrawable without touching it).
  tradingBudgetSol?: number | null;
  tradingCapitalSol?: number | null;
  realizedLossSol?: number;
  deployedSol?: number;
  protectedProfitSol?: number;
  error?: string;
}

interface UserWalletState {
  hotWalletPublicKey: string | null;
  balanceSol: number | null;
  minBalanceForAutoTradeSol: number | null;
  maxOpenPositions: number | null;
  openPositions: number | null;
  minTradeSol: number | null;
  feeReserveSol: number | null;
  dailyLossPct: number | null;
  maxDailyLossPct: number | null;
  serverMaxOpenPositions: number | null;
  tradingBudgetSol: number | null;
  tradingCapitalSol: number | null;
  realizedLossSol: number | null;
  deployedSol: number | null;
  protectedProfitSol: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_MS = 15_000;

/**
 * The bot-generated custodial trading wallet for the currently connected
 * owner wallet (created on first lookup). Deposits sent to hotWalletPublicKey
 * fund what the bot trades with on this user's behalf.
 *
 * Backed by SWR, which shares one request and one poll between every
 * component that calls this hook (the readiness card, settings dialog,
 * deposit panel, risk panel...). It used to start a separate 15-second poll
 * per caller. SWR also keys its data by wallet, so a slow response for a
 * wallet the user has since switched away from can never be shown for the new
 * one.
 */
export function useUserWallet(): UserWalletState {
  const { publicKey } = useSolanaWallet();
  const owner = publicKey ? publicKey.toBase58() : null;

  const { data, error, isLoading, mutate } = useSWR<UserWalletResponse>(
    owner ? `/api/user-wallet/${owner}` : null,
    (url: string) => fetcher<UserWalletResponse>(url),
    {
      refreshInterval: POLL_MS,
      dedupingInterval: 5_000,
      revalidateOnFocus: false,
    }
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const ok = data?.success ? data : null;
  const message =
    (error as Error | undefined)?.message ??
    (data && !data.success
      ? data.error || "Failed to load trading wallet"
      : null);

  return {
    hotWalletPublicKey: ok?.hotWalletPublicKey ?? null,
    balanceSol: ok?.balanceSol ?? null,
    minBalanceForAutoTradeSol: ok?.minBalanceForAutoTradeSol ?? null,
    maxOpenPositions: ok?.maxOpenPositions ?? null,
    openPositions: ok?.openPositions ?? null,
    minTradeSol: ok?.minTradeSol ?? null,
    feeReserveSol: ok?.feeReserveSol ?? null,
    dailyLossPct: ok?.dailyLossPct ?? null,
    maxDailyLossPct: ok?.maxDailyLossPct ?? null,
    serverMaxOpenPositions: ok?.serverMaxOpenPositions ?? null,
    tradingBudgetSol: ok?.tradingBudgetSol ?? null,
    tradingCapitalSol: ok?.tradingCapitalSol ?? null,
    realizedLossSol: ok?.realizedLossSol ?? null,
    deployedSol: ok?.deployedSol ?? null,
    protectedProfitSol: ok?.protectedProfitSol ?? null,
    loading: isLoading,
    error: ok ? null : message,
    refresh,
  };
}

export default useUserWallet;
