// backend/src/services/execution/raydiumProgramIds.ts
//
// Pinned program IDs for every Raydium pool type the native execution path
// is allowed to trade against, keyed to the exact on-chain program that
// owns pool accounts of that type. This module is intentionally the only
// place these IDs are allowed to live — poolVerification.service.ts and any
// future per-type executor (raydium/cpmm.ts, raydium/ammV4.ts,
// raydium/clmm.ts) must import from here rather than hardcoding a program
// ID inline, so there is exactly one place to update if Raydium ships a new
// program version.
//
// "Pinned" is the operative word: an unrecognized dex string, or a pool
// account whose actual on-chain owner doesn't match the ID pinned here for
// its claimed type, is a hard rejection (see poolVerification.service.ts),
// never a best-effort parse. A webhook payload's `dex` field is untrusted
// input — it says what QuickNode's Stream Function believes the pool is,
// not what it verifiably is on-chain.
export type RaydiumPoolType =
  | "raydium-cpmm"
  | "raydium-amm-v4"
  | "raydium-clmm";

export const RAYDIUM_PROGRAM_IDS: Record<RaydiumPoolType, string> = {
  // Raydium CPMM (Constant Product Market Maker) — Anchor-based program.
  "raydium-cpmm": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  // Raydium AMM V4 (the original/legacy Liquidity Pool V4 program).
  "raydium-amm-v4": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  // Raydium CLMM (Concentrated Liquidity Market Maker).
  "raydium-clmm": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
};

// Normalizes whatever dex string a QuickNode Stream Function happens to
// emit (casing/hyphenation isn't guaranteed to be consistent) to one of the
// canonical types above. Returns null for anything not in the pinned list —
// including real DEXes we simply don't have a native executor for yet
// (Orca, Meteora, PumpSwap, FluxBeam). Callers treat null as "not eligible
// for native execution," not as an error; those candidates keep trading
// through the existing Jupiter path exactly as they do today.
export function toCanonicalRaydiumPoolType(
  dex: string,
): RaydiumPoolType | null {
  const normalized = dex.trim().toLowerCase().replace(/[_\s]/g, "-");
  switch (normalized) {
    case "raydium-cpmm":
    case "raydium-cp":
      return "raydium-cpmm";
    case "raydium-amm-v4":
    case "raydium-amm":
    case "raydium-v4":
      return "raydium-amm-v4";
    case "raydium-clmm":
      return "raydium-clmm";
    default:
      return null;
  }
}
