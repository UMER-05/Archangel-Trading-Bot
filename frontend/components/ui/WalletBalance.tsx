import React from "react";
import { Wallet } from "lucide-react";
import { useWallet } from "@hooks/useWallet";

export default function WalletBalance() {
  const { balance, connected } = useWallet();
  return (
    <div className="inline-flex items-center gap-2.5 bg-white/[0.03] border border-white/[0.07] rounded-full pl-3 pr-4 py-1.5">
      <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/15 text-primary">
        <Wallet size={13} />
      </span>
      <span className="text-xs text-base-content/50 font-medium">
        Balance
      </span>
      <span className="font-mono font-semibold text-sm text-base-content tabular-nums">
        {connected ? balance.toFixed(3) : "—"}{" "}
        <span className="text-base-content/40 font-normal">SOL</span>
      </span>
    </div>
  );
}
