// frontend/components/trading/WatchlistPanel.tsx
"use client";

import React, { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@components/ui/card";
import { Input } from "@components/ui/input";
import { Button } from "@components/ui/button";
import { useWatchlist } from "@hooks/useWatchlist";
import { toast } from "react-hot-toast";
import { Star, Trash2, Bell, Loader2 } from "lucide-react";

export function WatchlistPanel() {
  const { tokens, loading, connected, addToken, removeToken, setPriceAlert } =
    useWatchlist();
  const [mintInput, setMintInput] = useState("");
  const [symbolInput, setSymbolInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [alertingMint, setAlertingMint] = useState<string | null>(null);
  const [alertPrice, setAlertPrice] = useState("");
  const [alertCondition, setAlertCondition] = useState<"above" | "below">(
    "above"
  );

  const handleAdd = async () => {
    const mint = mintInput.trim();
    if (!mint) return;

    setAdding(true);
    try {
      const res = await addToken(mint, symbolInput.trim() || undefined);
      if (res?.success) {
        toast.success("Added to watchlist");
        setMintInput("");
        setSymbolInput("");
      } else {
        toast.error(res?.error || "Failed to add token");
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (mint: string) => {
    const res = await removeToken(mint);
    if (res?.success) {
      toast.success("Removed from watchlist");
    } else {
      toast.error("Failed to remove token");
    }
  };

  const openAlertForm = (
    mint: string,
    existing?: { targetPrice: number; condition: "above" | "below" }
  ) => {
    setAlertingMint(mint);
    setAlertPrice(existing?.targetPrice ? String(existing.targetPrice) : "");
    setAlertCondition(existing?.condition ?? "above");
  };

  const handleSaveAlert = async () => {
    if (!alertingMint || !alertPrice) return;
    const res = await setPriceAlert(
      alertingMint,
      Number(alertPrice),
      alertCondition
    );
    if (res?.success) {
      toast.success("Price alert set");
      setAlertingMint(null);
    } else {
      toast.error("Failed to set price alert");
    }
  };

  return (
    <Card className="bg-base-200 rounded-xl shadow p-4">
      <CardHeader>
        <CardTitle className="text-lg font-semibold text-primary flex items-center gap-2">
          <Star size={18} />
          Watchlist
          <span className="text-xs font-normal text-gray-400">
            ({tokens.length})
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Add form — stacked so the symbol input + Add button never get
            squeezed past the card's edge in this narrow column. */}
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Token mint address"
            value={mintInput}
            onChange={(e) => setMintInput(e.target.value)}
            className="w-full"
          />
          <div className="flex gap-2">
            <Input
              placeholder="Symbol (optional)"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              className="flex-1 min-w-0"
            />
            <Button
              onClick={handleAdd}
              disabled={!connected || adding || !mintInput.trim()}
              className="flex-shrink-0"
            >
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </div>
        </div>

        {!connected && (
          <div className="text-xs text-yellow-400">
            Connect your wallet — your watchlist is private to it.
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading watchlist...
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center">
            No tokens watched yet. Add a mint address above.
          </div>
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div
                key={t.mint}
                className="bg-base-300/40 rounded-lg p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      {t.symbol || t.name || "Unknown"}
                    </div>
                    <div className="text-xs text-gray-500 font-mono">
                      {t.mint.slice(0, 8)}...{t.mint.slice(-4)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openAlertForm(t.mint, t.priceAlert)}
                      className={`p-1.5 rounded transition ${
                        t.priceAlert
                          ? "text-yellow-400 hover:text-yellow-300"
                          : "text-gray-500 hover:text-gray-300"
                      }`}
                      title={
                        t.priceAlert
                          ? `Alert: ${t.priceAlert.condition} $${t.priceAlert.targetPrice}`
                          : "Set price alert"
                      }
                    >
                      <Bell className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleRemove(t.mint)}
                      className="p-1.5 rounded text-gray-500 hover:text-red-400 transition"
                      title="Remove from watchlist"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {t.priceAlert && alertingMint !== t.mint && (
                  <div className="text-xs text-yellow-400/80">
                    🔔 Alert when {t.priceAlert.condition} $
                    {t.priceAlert.targetPrice}
                    {t.priceAlert.triggered && " (triggered)"}
                  </div>
                )}

                {alertingMint === t.mint && (
                  <div className="flex items-center gap-2 pt-1">
                    <select
                      value={alertCondition}
                      onChange={(e) =>
                        setAlertCondition(e.target.value as "above" | "below")
                      }
                      className="bg-base-100 border border-base-300 rounded px-2 py-1 text-xs"
                    >
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                    </select>
                    <Input
                      type="number"
                      step="any"
                      placeholder="Target price ($)"
                      value={alertPrice}
                      onChange={(e) => setAlertPrice(e.target.value)}
                      className="h-8 text-xs flex-1"
                    />
                    <Button
                      onClick={handleSaveAlert}
                      disabled={!alertPrice}
                      className="h-8 text-xs px-3"
                    >
                      Save
                    </Button>
                    <button
                      onClick={() => setAlertingMint(null)}
                      className="text-xs text-gray-400 hover:text-gray-200 px-2"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default WatchlistPanel;
