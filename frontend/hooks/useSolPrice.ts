// frontend/hooks/useSolPrice.ts
"use client";

import { useEffect, useState } from "react";
import { fetcher } from "@lib/utils";

const POLL_MS = 60000;

/**
 * Live SOL/USD price for "~$X" display estimates. Several modals used to
 * hardcode a stale $150-$200 conversion rate for this — this hook replaces
 * those with the real, live-fetched price (backend/src/routes/tokens.route.ts,
 * itself backed by jupiter.service.ts's 30s-cached getSolPriceUsd()).
 */
export function useSolPrice(): number | null {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const res = await fetcher<{ success: boolean; price: number }>(
          "/api/tokens/sol-price"
        );
        if (mounted && res?.success) setPrice(res.price);
      } catch {
        // keep last known price on transient failure
      }
    };

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return price;
}

export default useSolPrice;
