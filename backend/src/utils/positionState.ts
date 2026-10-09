// backend/src/utils/positionState.ts
//
// ONE definition of "is this position still open?", shared by everything that
// counts, lists, monitors or liquidates positions.
//
// Why it isn't just `netSol > dust`: netSol is (SOL spent buying) minus (SOL
// received selling), i.e. the position's remaining COST, not what's held.
//   - closed at a PROFIT  -> netSol goes negative (fine, reads as closed)
//   - closed at a LOSS    -> netSol stays positive forever (the loss)
// so a position that was fully sold at a loss looked open indefinitely. It was
// counted against Max Open Positions, listed on the dashboard (with a price
// lookup per refresh), re-checked by the monitor every 5 seconds, and offered
// for sale by "Sell All & Stop" — with nothing left to sell. The reliable
// signal is the position's own remainingPct, which the monitor sets to 0 on a
// final exit; it is 100 when bought and drops with each partial sale.

export const POSITION_DUST_THRESHOLD_SOL = Number(
  process.env.POSITION_DUST_THRESHOLD_SOL ?? 0.0005,
);

export interface PositionLike {
  netSol: number;
  remainingPct?: number | undefined;
  custody?: "self" | "custodial" | null | undefined;
}

export function isOpenPosition(
  p: PositionLike,
  dust: number = POSITION_DUST_THRESHOLD_SOL,
): boolean {
  if (typeof p.remainingPct === "number" && p.remainingPct <= 0) return false;
  return Number.isFinite(p.netSol) && p.netSol >= dust;
}

/**
 * Open AND managed by the bot. Self-custody (manual) positions are the
 * user's own: the bot neither monitors nor sells them, and they don't use one
 * of its position slots.
 */
// Takes ONE argument on purpose: Array.filter calls its callback with
// (element, index, array), and this used to take a second `dust` parameter —
// which meant `.filter(isBotManagedOpenPosition)` silently fed the array
// INDEX in as a multi-SOL dust threshold, dropping every position past the
// first from being counted as open. Pass a custom threshold as
// isBotManagedOpenPosition(p, { dust }) if a caller genuinely needs one
// (none currently do); this shape can never be miscalled via .filter/.map.
export function isBotManagedOpenPosition(
  p: PositionLike,
  opts: { dust?: number } = {},
): boolean {
  const dust = opts.dust ?? POSITION_DUST_THRESHOLD_SOL;
  return p.custody !== "self" && isOpenPosition(p, dust);
}

export type PositionState = "open" | "closed" | "ghost";

/**
 * For the cleanup tool. `onChainRaw` is the token balance actually held, or
 * null if it wasn't (or couldn't be) checked.
 *   open   the ledger says open, and tokens are held (or not checked)
 *   closed fully exited (remainingPct 0) or nothing left in the ledger
 *   ghost  the ledger says open but the wallet holds none — sold or lost
 *          without the position ever being marked closed
 */
export function classifyPosition(
  p: PositionLike,
  onChainRaw: string | null,
  dust: number = POSITION_DUST_THRESHOLD_SOL,
): PositionState {
  if (!isOpenPosition(p, dust)) return "closed";
  if (onChainRaw !== null && /^0+$/.test(onChainRaw)) return "ghost";
  return "open";
}

export interface CostedPosition extends PositionLike {
  /** Total SOL spent buying the position. */
  boughtSol?: number | undefined;
}

/**
 * SOL at work: the cost of the part of each bot-held open position that is
 * still held (what was spent buying it x the share not yet sold). This is the
 * figure a trading budget is measured against. Closed positions and the
 * user's own self-custody positions don't count.
 */
export function deployedSolOf(
  positions: CostedPosition[],
  dust: number = POSITION_DUST_THRESHOLD_SOL,
): number {
  return positions
    .filter((p) => isBotManagedOpenPosition(p, { dust }))
    .reduce((sum, p) => {
      const bought = p.boughtSol ?? Math.max(p.netSol, 0);
      const held =
        typeof p.remainingPct === "number"
          ? Math.min(Math.max(p.remainingPct, 0), 100) / 100
          : 1;
      return sum + bought * held;
    }, 0);
}

export interface LossPosition extends PositionLike {
  /** When the position's most recent sale happened. */
  lastSellAt?: Date | string | number | null | undefined;
}

/**
 * SOL lost on bot positions that were CLOSED at or after `sinceMs`. A closed
 * position's netSol is what it cost minus what came back: positive = a loss,
 * negative = a profit. Only losses count here — that is the point: a trading
 * budget's capital shrinks when a position loses but never grows when one
 * wins, so profits stay outside the capital the bot may trade with.
 * Positions still open, and the user's own self-custody ones, don't count.
 */
export function realizedLossSolSince(
  positions: LossPosition[],
  sinceMs: number,
  dust: number = POSITION_DUST_THRESHOLD_SOL,
): number {
  return positions
    .filter((p) => p.custody !== "self" && !isOpenPosition(p, dust))
    .filter((p) => {
      if (p.lastSellAt == null) return false;
      const at = new Date(p.lastSellAt).getTime();
      return Number.isFinite(at) && at >= sinceMs;
    })
    .reduce(
      (sum, p) => sum + (Number.isFinite(p.netSol) ? Math.max(p.netSol, 0) : 0),
      0,
    );
}
