// backend/src/services/execution/positionExitCoordinator.service.ts
//
// Sell-side counterpart to discoveryCoordinator.service.ts. That module
// stops two overlapping buy attempts from processing the same mint at
// once; this one stops two overlapping SELL attempts from processing the
// same (wallet, position) at once — doc 13 point 9: "the sell side needs
// the same claim/lease guard the buy side has... two monitor ticks could
// both decide to sell the same position at once."
//
// Same shape deliberately: an in-memory Set for the fast local check plus
// a Mongo lease (db.service.ts's claimPositionExit/etc.) for the
// cross-process-safe source of truth, a renewal timer so a slow sell
// (waiting on sendAndConfirmWithRetry) doesn't have its lease expire out
// from under it mid-flight, and a release-on-failure / complete-on-success
// split so a failed sell attempt can be retried by the next monitor tick
// rather than being stuck "claimed" forever.
const claimedPositions = new Set<string>();
import crypto from "crypto";
import dbService from "../db.service.js";

const ownerId = `${process.pid}:${crypto.randomUUID()}`;
const renewalTimers = new Map<string, NodeJS.Timeout>();

function positionKey(token: string, wallet: string): string {
  return `${wallet}:${token}`;
}

export async function claimPositionExit(
  token: string,
  wallet: string,
): Promise<boolean> {
  const key = positionKey(token, wallet);
  if (claimedPositions.has(key)) return false;
  const claimed = await dbService.claimPositionExit(token, wallet, ownerId);
  if (claimed) {
    claimedPositions.add(key);
    renewalTimers.set(
      key,
      setInterval(() => {
        void dbService
          .renewPositionExit(token, wallet, ownerId)
          .catch(() => {});
      }, 30_000),
    );
  }
  return claimed;
}

export async function completePositionExit(
  token: string,
  wallet: string,
): Promise<void> {
  const key = positionKey(token, wallet);
  const timer = renewalTimers.get(key);
  if (timer) clearInterval(timer);
  renewalTimers.delete(key);
  claimedPositions.delete(key);
  await dbService.completePositionExit(token, wallet, ownerId);
}

export async function releasePositionExit(
  token: string,
  wallet: string,
): Promise<void> {
  const key = positionKey(token, wallet);
  const timer = renewalTimers.get(key);
  if (timer) clearInterval(timer);
  renewalTimers.delete(key);
  claimedPositions.delete(key);
  await dbService.releasePositionExit(token, wallet, ownerId);
}

export function clearAllPositionExitClaims(): void {
  for (const timer of renewalTimers.values()) clearInterval(timer);
  renewalTimers.clear();
  claimedPositions.clear();
}

export function claimedPositionExitCount(): number {
  return claimedPositions.size;
}
