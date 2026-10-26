// backend/src/utils/monitorHealth.ts
//
// Liveness state for the position monitor (services/monitor.service.ts).
// Kept in its own dependency-free module so the admin API can report it
// without importing the monitor itself (which opens an RPC connection at
// module load and drags Jupiter/emergency-exit code into any route test).

// If no tick completes within this window the monitor is considered stale
// (RPC down, Jupiter down, process wedged) — every open position is then
// unprotected, which must be alerted on rather than discovered later.
export const MONITOR_STALE_ALERT_MS = Number(
  process.env.MONITOR_STALE_ALERT_MS ?? 120_000,
);

export const monitorHealth = {
  startedAt: 0,
  tickRunning: false,
  lastTickStartedAt: 0,
  lastTickCompletedAt: 0,
  lastTickDurationMs: 0,
  lastTickPositions: 0,
  overlapsSkipped: 0,
  ticksCompleted: 0,
  lastError: null as string | null,
  lastStaleNotifiedAt: 0,
};

/** Snapshot of the position monitor's liveness — exposed via the admin API
 * so a dashboard/ops check can tell "the bot is up" from "the bot is
 * actually protecting positions". */
export function getMonitorHealth() {
  const now = Date.now();
  const sinceLastTick = monitorHealth.lastTickCompletedAt
    ? now - monitorHealth.lastTickCompletedAt
    : null;
  return {
    ...monitorHealth,
    sinceLastTickMs: sinceLastTick,
    stale:
      monitorHealth.startedAt > 0 &&
      (sinceLastTick === null
        ? now - monitorHealth.startedAt > MONITOR_STALE_ALERT_MS
        : sinceLastTick > MONITOR_STALE_ALERT_MS),
    staleAfterMs: MONITOR_STALE_ALERT_MS,
  };
}
