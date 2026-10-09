const claimedMints = new Set<string>();
import crypto from "crypto";
import dbService from "./db.service.js";

const ownerId = `${process.pid}:${crypto.randomUUID()}`;
const renewalTimers = new Map<string, NodeJS.Timeout>();

export async function claimMint(mint: string): Promise<boolean> {
  if (claimedMints.has(mint)) return false;
  const claimed = await dbService.claimDiscoveryMint(mint, ownerId);
  if (claimed) {
    claimedMints.add(mint);
    renewalTimers.set(
      mint,
      setInterval(() => {
        void dbService.renewDiscoveryMint(mint, ownerId).catch(() => {});
      }, 30_000),
    );
  }
  return claimed;
}

export async function completeMint(mint: string): Promise<void> {
  const timer = renewalTimers.get(mint);
  if (timer) clearInterval(timer);
  renewalTimers.delete(mint);
  claimedMints.delete(mint);
  await dbService.completeDiscoveryMint(mint, ownerId);
}

export async function releaseMint(mint: string): Promise<void> {
  const timer = renewalTimers.get(mint);
  if (timer) clearInterval(timer);
  renewalTimers.delete(mint);
  claimedMints.delete(mint);
  await dbService.releaseDiscoveryMint(mint, ownerId);
}

export function clearAllMints(): void {
  for (const timer of renewalTimers.values()) clearInterval(timer);
  renewalTimers.clear();
  claimedMints.clear();
}

export function claimedMintCount(): number {
  return claimedMints.size;
}
