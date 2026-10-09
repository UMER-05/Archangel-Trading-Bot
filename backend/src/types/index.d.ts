// backend/src/types/index.d.ts

import { Server as SocketIOServer } from "socket.io";
import type { Express } from "express";

/* -------------------------------------------------------------------------- */
/*                              Trade Record (DB)                              */
/* -------------------------------------------------------------------------- */

export interface TradeRecord {
  id: string;
  type: "buy" | "sell";
  token: string;
  inputMint?: string;
  outputMint?: string;
  amountLamports: number;
  amountSol: number;
  price?: number;
  pnl?: number;
  pnlSol?: number;
  wallet?: string;
  simulated?: boolean;
  signature?: string | null;
  timestamp: Date;
  auto?: boolean;
  reason?: "autobuy" | "autosell" | "TP" | "SL";
  route?: "jupiter";
}

/* -------------------------------------------------------------------------- */
/*                               Socket Events                                */
/* -------------------------------------------------------------------------- */

export interface TradeFeedPayload extends TradeRecord {}

export interface PriceUpdatePayload {
  token: string;
  mint: string;
  price: number;
  timestamp: string;
}

export type SocketEvents =
  | { event: "tradeFeed"; payload: TradeFeedPayload }
  | { event: "priceUpdate"; payload: PriceUpdatePayload }
  | { event: "token_prices"; payload: any };

/* -------------------------------------------------------------------------- */
/*                           Extend Express Types                              */
/* -------------------------------------------------------------------------- */

declare global {
  namespace Express {
    interface Application {
      get(name: "io"): SocketIOServer | undefined;
    }

    interface Request {
      io?: SocketIOServer;
    }
  }

  namespace NodeJS {
    interface ProcessEnv {
      PORT?: string;
      FRONTEND_URL?: string;
      MONGO_URI?: string;
      MONGO_DB_NAME?: string;

      SOLANA_RPC_URL?: string;
      SOLANA_WS_URL?: string;
      SOLANA_COMMITMENT?: string;

      SECRET_KEY?: string;
      WALLET_SECRET_KEY?: string;
      WALLET_PRIVATE_KEY?: string;
      WALLET_PUBLIC_KEY?: string;
      SERVER_PUBLIC_KEY?: string;
      BACKEND_RECEIVER_WALLET?: string;

      USE_REAL_SWAP?: string;
      TP_PCT?: string;
      SL_PCT?: string;

      JUPITER_API_URL?: string;
      JUPITER_API_KEY?: string;
      JUPITER_AUTO_BUY?: string;
      JUPITER_AUTO_BUY_SOL?: string;
      MIN_JUPITER_LIQUIDITY_SOL?: string;

      // Execution router (services/execution/executionRouter.service.ts).
      // Defaults to disabled — see that file's header comment. Until a
      // native executor is registered in NATIVE_EXECUTOR_REGISTRY, setting
      // this to "true" has no effect: every candidate still routes to
      // Jupiter.
      RAYDIUM_NATIVE_EXECUTION_ENABLED?: string;
      // Per-executor readiness flags — see registerNativeExecutors.ts.
      // Both this AND RAYDIUM_NATIVE_EXECUTION_ENABLED must be "true" for
      // the CPMM executor to ever run for a real candidate.
      RAYDIUM_CPMM_EXECUTOR_ENABLED?: string;
      RAYDIUM_CPMM_SLIPPAGE_PCT?: string;
      RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT?: string;
      RAYDIUM_CPMM_PRIORITY_FEE_MICROLAMPORTS?: string;
      // MEV/Jito routing (docs/mev-jito-routing-spec.md) — see
      // services/execution/transaction/jitoSender.ts. Defaults to "rpc"
      // (today's existing send path, unchanged).
      RAYDIUM_SEND_STRATEGY?: string;
      RAYDIUM_JITO_TIP_LAMPORTS?: string;
      JITO_BLOCK_ENGINE_URL?: string;
    }
  }
}

export {};
