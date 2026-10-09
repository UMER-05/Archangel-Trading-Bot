"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";
import { useWallet } from "@hooks/useWallet";
import { useTradingConfigStore } from "@hooks/useConfig";
import { useStats } from "@hooks/useStats";
import { useSocket } from "@hooks/useSocket";
import { fetcher } from "@lib/utils";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";

export const useTrade = () => {
  const { publicKey, connected, refreshBalance } = useWallet();
  const wallet = useSolanaWallet();
  const { selectedToken } = useTradingConfigStore();

  const { stats, updateStats } = useStats();
  const { sendMessage } = useSocket();

  const [loading, setLoading] = useState(false);

  const executeTrade = async (
    type: "buy" | "sell",
    tokenMint: string,
    // Already in the correct base unit for the swap direction — SOL lamports
    // for a buy, the token's own raw units for a sell (see the Sell page,
    // which fetches the real on-chain balance rather than assuming a SOL
    // quantity means anything for a token that isn't SOL). Required — there's
    // no longer a store-wide default trade size to fall back to.
    amountLamportsOverride: number | string
  ) => {
    if (!connected || !publicKey) {
      toast.error("Connect your wallet to trade.");
      return null;
    }

    if (!wallet.signTransaction) {
      toast.error("Wallet does not support transaction signing.");
      return null;
    }

    if (
      amountLamportsOverride === undefined ||
      amountLamportsOverride === null
    ) {
      toast.error("Missing trade amount.");
      return null;
    }

    setLoading(true);
    toast.loading(`${type === "buy" ? "Buying" : "Selling"} ${tokenMint}…`, {
      id: "trade-status",
    });

    try {
      // A sell's override can be a token's raw base-unit balance — for a
      // token with a large supply/decimals this routinely exceeds
      // Number.MAX_SAFE_INTEGER, so round-tripping it through Number()
      // silently loses precision (and can render in scientific notation once
      // serialized), which breaks Jupiter's fixed-width amount encoding
      // downstream ("encoding overruns Uint8Array"). Passed through as-is —
      // already a valid integer string/number in the right base unit.
      const amountLamports: number | string = amountLamportsOverride;
      const inputMint =
        type === "buy"
          ? "So11111111111111111111111111111111111111112"
          : tokenMint;
      const outputMint =
        type === "buy"
          ? tokenMint
          : "So11111111111111111111111111111111111111112";
      const mint = tokenMint || selectedToken;
      if (!mint) throw new Error("Missing token");

      // Step 1: Prepare unsigned transaction
      toast.loading("Preparing transaction...", { id: "trade-status" });
      const prepareRes: any = await fetcher("/api/trade/prepare", {
        method: "POST",
        body: JSON.stringify({
          type,
          inputMint,
          outputMint,
          wallet: publicKey,
          amountLamports,
        }),
      });

      if (!prepareRes?.success) {
        throw new Error(prepareRes?.message || "Failed to prepare transaction");
      }

      let signedTxBase64: string | undefined;

      if (!prepareRes.data?.transaction) {
        throw new Error("No transaction data received");
      }

      toast.loading("Sign transaction in your wallet...", {
        id: "trade-status",
      });

      const txBuffer = Buffer.from(prepareRes.data.transaction, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);

      const signedTx = await wallet.signTransaction(transaction);
      signedTxBase64 = Buffer.from(signedTx.serialize()).toString("base64");

      // Step 2: Confirm with backend
      toast.loading("Confirming transaction...", { id: "trade-status" });
      const confirmRes: any = await fetcher("/api/trade/confirm", {
        method: "POST",
        body: JSON.stringify({
          signedTransaction: signedTxBase64,
          type,
          token: mint,
          amountLamports,
          wallet: publicKey,
          slippageBps: prepareRes.data.slippageBps,
        }),
        // The backend broadcasts your signed transaction and waits for the
        // chain to confirm it — routinely longer than the 30s default when
        // Solana is busy, which reported a still-landing trade as failed.
        timeoutMs: 90_000,
      });

      if (!confirmRes?.success) {
        // A failed confirmation is a real failure — surface it as one instead
        // of fabricating a fake "successful" trade with random price/PnL. This
        // used to silently show a success toast for trades that never happened.
        throw new Error(confirmRes?.message || "Trade confirmation failed");
      }

      const d = confirmRes.data;
      const trade: any = {
        simulated: false,
        id: d.id ?? crypto.randomUUID(),
        type,
        token: d.token ?? mint,
        amount: Number(d.amountLamports ?? amountLamports),
        price: Number(d.price ?? 0),
        pnl: Number(d.pnl) || 0,
        signature: d.signature ?? null,
        timestamp: d.timestamp ?? new Date().toISOString(),
      };

      // 👉 Broadcast live event properly
      sendMessage("tradeFeed", trade);

      // 📊 Update stats correctly
      const amountSol = trade.amount / 1e9;

      updateStats({
        tradeVolumeSol: stats.tradeVolumeSol + amountSol,
        openTrades:
          type === "buy"
            ? stats.openTrades + 1
            : Math.max(stats.openTrades - 1, 0),
      });

      toast.success(
        `${type === "buy" ? "Bought" : "Sold"} ${trade.token} ${
          trade.simulated ? "(sim)" : ""
        }`,
        { id: "trade-status" }
      );

      // Trigger immediate balance refresh after trade (portfolio hook will update PnL)
      console.log("✅ Trade completed, refreshing wallet balance...");
      setTimeout(() => {
        refreshBalance();
      }, 2000); // Wait 2s for blockchain confirmation

      return trade;
    } catch (err: any) {
      const errorMessage = err.message || "Unknown error";
      const duration = 5000;

      toast.error(`Trade failed: ${errorMessage}`, {
        id: "trade-status",
        duration,
      });

      console.error("Trade error:", err);
      return null;
    } finally {
      setLoading(false);
    }
  };

  return { executeTrade, loading };
};
