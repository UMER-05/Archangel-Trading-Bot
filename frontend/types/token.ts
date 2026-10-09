export interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
  price: number | null;
  pnl: number | null;
  liquidity: number | null;
  marketCap: number | null;
  // Lifecycle validation fields (Jupiter-only: a token either has a real
  // route + liquidity right now, or it doesn't — no separate bonding/graduation stages)
  lifecycleStage?: "tradable" | "zero_liquidity" | "not_tradable" | "unknown";
  lifecycleValidated?: boolean;
  isTradable?: boolean;
  hasLiquidity?: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
}
