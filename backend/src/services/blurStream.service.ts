// backend/src/services/blurStream.service.ts
//
// Solami Blur realtime stream -> candidate pipeline.
//
// The sole candidate-discovery path. Our backend opens one outbound WebSocket
// to Blur, subscribes to pool_create events only, and hands each decoded
// event to candidatePipeline.service.processCandidateMint. (The earlier
// QuickNode/Solami webhook routes have been removed.)
//
// DUPLICATES: Blur routinely reports the same mint more than once — a token
// that launches on pumpfun and is on pumpswap in the same block, or
// meteora_dbc followed by meteora_damm2 — sometimes in the same millisecond.
// processCandidateMint's TokenState lookup is check-then-write, so two
// simultaneous events for one mint BOTH pass it and both run the Jupiter and
// filter phases (only the buy claim later stops a double buy, after the
// quota has been spent). This class therefore drops repeat mints itself,
// synchronously, before the pipeline sees them (see isRecentDuplicate).
//
// Because there is no second discovery path, this file is responsible for:
//   - reconnecting after any drop, with exponential backoff + jitter
//   - noticing a half-open socket (no TCP close, no data) via ping/pong
//   - NOT hammering Solami when the failure is "you can't connect right now"
//     (bad key, or out of prepaid bandwidth/balance — close code 4002) and
//     alerting a human instead, since that is a discovery outage
//   - never letting an exception escape into the EventEmitter: index.ts exits
//     the process on uncaughtException, and a bot that signs transactions
//     should not be taken down by one malformed frame
//
// KNOWN LIMIT: Blur's live stream has no resume cursor. Events emitted while
// we're disconnected are lost, not replayed. For a sniper that's acceptable
// (a pool that's minutes old is already rejected by isFreshCandidate) but it
// means a reconnect gap is a real blind spot — watch the "reconnects" counter
// in the periodic stats log.
//
// The API key rides in the URL query string (that is how Blur authenticates a
// WebSocket). It must never be logged — only `safeUrl` (origin + path) is.
import WebSocket from "ws";
import { ENV } from "../utils/env.js";
import { getLogger } from "../utils/logger.js";
import type { CandidateMint } from "./tokenExtraction.service.js";
import { extractCandidateMintFromBlurEvent } from "./blurExtraction.service.js";
import { processCandidateMint } from "./candidatePipeline.service.js";
import { notifyError } from "./notifications/notify.service.js";

const LOG = getLogger("blur-stream");

// Blur closes a running stream with this code when prepaid bandwidth/balance
// runs out (see "Usage and billing" in the Blur docs).
const CLOSE_BALANCE_EXHAUSTED = 4002;

// HTTP statuses on the WebSocket upgrade that retrying fast will not fix.
const SLOW_RETRY_HTTP_STATUSES = new Set([401, 402, 403, 429]);

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // one human alert per hour, max

export interface BlurStreamTiming {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** A connection that stayed up this long resets the backoff ladder. */
  stableAfterMs: number;
  /** Retry cadence when the failure is auth/balance (not a blip). */
  slowRetryMs: number;
  statsIntervalMs: number;
  /** How long a mint that was already forwarded is ignored if re-reported. */
  dedupeTtlMs: number;
}

const DEFAULT_TIMING: BlurStreamTiming = {
  pingIntervalMs: 30_000,
  pongTimeoutMs: 20_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  stableAfterMs: 30_000,
  slowRetryMs: 60_000,
  statsIntervalMs: 5 * 60_000,
  dedupeTtlMs: 10 * 60_000,
};

export interface BlurStreamOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  /** Allow-list of DEX names (Blur's `dex` filter). Empty = every DEX. */
  dexes?: string[] | undefined;
  onCandidate?: ((candidate: CandidateMint) => Promise<void>) | undefined;
  onFatal?:
    | ((message: string, details: Record<string, unknown>) => void)
    | undefined;
  timing?: Partial<BlurStreamTiming> | undefined;
}

export interface BlurStreamStatus {
  connected: boolean;
  frames: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  reconnects: number;
  lastFrameAgeMs: number | null;
}

/**
 * Builds the subscribe URL. Only pool_create is requested: Blur meters per
 * delivered byte, and on a typical day liquidity events outnumber pool_create
 * by an order of magnitude — bytes we'd parse and throw away. metadata=false
 * suppresses the out-of-band metadata events for the same reason.
 */
export function buildBlurUrl(opts: {
  baseUrl: string;
  apiKey: string;
  dexes?: string[] | undefined;
}): { url: string; safeUrl: string } {
  const u = new URL(opts.baseUrl);
  u.searchParams.set("chain", "solana");
  u.searchParams.set("type", "pool_create");
  u.searchParams.set("metadata", "false");
  if (opts.dexes && opts.dexes.length > 0) {
    u.searchParams.set("dex", opts.dexes.join(","));
  }
  const safeUrl = `${u.origin}${u.pathname}`;
  u.searchParams.set("api_key", opts.apiKey);
  return { url: u.toString(), safeUrl };
}

function frameToText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class BlurStream {
  private ws: WebSocket | null = null;
  private running = false;
  private attempt = 0;
  private connectedAt = 0;
  private lastError = "";
  private unexpectedLogged = 0;
  private lastAlertAt = 0;
  // mint -> when we first forwarded it. Map iteration is insertion-ordered,
  // which is what lets isRecentDuplicate prune expired entries from the front.
  private recentMints = new Map<string, number>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  private readonly url: string;
  private readonly safeUrl: string;
  private readonly timing: BlurStreamTiming;
  private readonly onCandidate: (c: CandidateMint) => Promise<void>;
  private readonly onFatal: (
    message: string,
    details: Record<string, unknown>,
  ) => void;

  private stats = {
    frames: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    reconnects: 0,
    lastFrameAt: 0,
  };

  constructor(opts: BlurStreamOptions & { apiKey: string; baseUrl: string }) {
    const built = buildBlurUrl({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      dexes: opts.dexes,
    });
    this.url = built.url;
    this.safeUrl = built.safeUrl;
    this.timing = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
    this.onCandidate =
      opts.onCandidate ?? ((c) => processCandidateMint(c, "blur"));
    this.onFatal =
      opts.onFatal ??
      ((message, details) => {
        void notifyError({ source: "blur-stream", message, details });
      });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.statsTimer = setInterval(
      () => this.logStats(),
      this.timing.statsIntervalMs,
    );
    this.statsTimer.unref();
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(1000, "shutdown");
      } catch {
        // Already closing/closed — nothing to do.
      }
    }
  }

  status(): BlurStreamStatus {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      frames: this.stats.frames,
      accepted: this.stats.accepted,
      rejected: this.stats.rejected,
      duplicates: this.stats.duplicates,
      reconnects: this.stats.reconnects,
      lastFrameAgeMs: this.stats.lastFrameAt
        ? Date.now() - this.stats.lastFrameAt
        : null,
    };
  }

  private connect(): void {
    if (!this.running) return;
    this.lastError = "";

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
    } catch (err: any) {
      LOG.error({ err: err?.message }, "Could not construct Blur WebSocket");
      this.scheduleReconnect(this.nextBackoffMs());
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.connectedAt = Date.now();
      LOG.info(
        { url: this.safeUrl, attempt: this.attempt },
        "🔌 Blur stream connected (pool_create)",
      );
      this.startHeartbeat(ws);
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      // Any inbound data proves the link is alive.
      this.clearPongTimer();
      try {
        this.handleFrame(frameToText(data));
      } catch (err: any) {
        LOG.error({ err: err?.message }, "Blur frame handler threw — ignored");
      }
    });

    ws.on("pong", () => {
      if (this.ws !== ws) return;
      this.clearPongTimer();
    });

    // An 'error' listener MUST exist: with none, ws re-throws it as an
    // uncaught exception and index.ts would exit the whole process. A failed
    // upgrade (bad key, no balance) arrives here as
    // "Unexpected server response: 401", followed by 'close'.
    ws.on("error", (err: Error) => {
      this.lastError = err?.message ?? String(err);
      LOG.warn({ err: this.lastError }, "Blur stream socket error");
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = null;

      const upMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
      this.connectedAt = 0;
      if (upMs >= this.timing.stableAfterMs) this.attempt = 0;

      if (!this.running) return;

      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      const httpStatus = Number(
        /Unexpected server response: (\d{3})/.exec(this.lastError)?.[1] ?? 0,
      );
      const slow =
        code === CLOSE_BALANCE_EXHAUSTED ||
        SLOW_RETRY_HTTP_STATUSES.has(httpStatus);

      if (slow) {
        this.alertOnce("Blur stream can't stay connected — discovery is DOWN", {
          closeCode: code,
          httpStatus: httpStatus || undefined,
          reason: reason || undefined,
          hint:
            code === CLOSE_BALANCE_EXHAUSTED || httpStatus === 402
              ? "Out of prepaid bandwidth/balance — top up in the Solami dashboard."
              : "Check SOLAMI_BLUR_API_KEY (needs the DataApi permission).",
        });
        LOG.error(
          { code, httpStatus, reason, retryInMs: this.timing.slowRetryMs },
          "Blur stream refused/closed — slow retry",
        );
        this.scheduleReconnect(this.timing.slowRetryMs);
        return;
      }

      const delay = this.nextBackoffMs();
      LOG.warn(
        { code, reason, upMs, retryInMs: delay },
        "Blur stream closed — reconnecting",
      );
      this.scheduleReconnect(delay);
    });
  }

  private handleFrame(text: string): void {
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      LOG.warn({ sample: text.slice(0, 200) }, "Non-JSON Blur frame ignored");
      return;
    }

    this.stats.frames++;
    this.stats.lastFrameAt = Date.now();

    const type = (event as { type?: unknown } | null)?.type;
    if (type !== "pool_create") {
      // We only subscribed to pool_create, so anything else is either a
      // server control/error message or a filter that didn't take. Surface
      // the first few (they're the fastest way to spot a misconfigured
      // subscription), then stay quiet.
      if (this.unexpectedLogged < 5) {
        this.unexpectedLogged++;
        LOG.warn(
          { type, sample: text.slice(0, 300) },
          "Blur frame other than pool_create ignored",
        );
      }
      return;
    }

    const candidate = extractCandidateMintFromBlurEvent(event);
    if (!candidate) {
      // Expected and frequent: many pools (e.g. launchpad tokens quoted in
      // another token) have no SOL/USDC/USDT side and are not candidates.
      this.stats.rejected++;
      return;
    }

    if (this.isRecentDuplicate(candidate.mint, Date.now())) {
      this.stats.duplicates++;
      LOG.debug(
        { mint: candidate.mint.slice(0, 8), dex: candidate.dex },
        "Blur pool_create for a mint already forwarded — skipping",
      );
      return;
    }

    this.stats.accepted++;
    LOG.debug(
      {
        mint: candidate.mint.slice(0, 8),
        dex: candidate.dex,
        ageMs: Date.now() - candidate.poolCreatedAt.getTime(),
      },
      "Blur pool_create accepted",
    );

    this.onCandidate(candidate).catch((err: any) => {
      LOG.error(
        { mint: candidate.mint.slice(0, 8), err: err?.message },
        "Candidate pipeline failed unexpectedly",
      );
    });
  }

  /**
   * True if this mint was already forwarded within dedupeTtlMs. Otherwise
   * records it and returns false. Fully synchronous on purpose: two frames
   * for one mint arriving back-to-back are handled one after the other, so
   * the second always sees the first — unlike the pipeline's async
   * check-then-write, which both frames can pass at once.
   */
  private isRecentDuplicate(mint: string, now: number): boolean {
    const ttl = this.timing.dedupeTtlMs;
    const seenAt = this.recentMints.get(mint);
    if (seenAt !== undefined && now - seenAt < ttl) return true;

    this.recentMints.delete(mint);
    this.recentMints.set(mint, now);
    for (const [m, at] of this.recentMints) {
      if (now - at < ttl) break;
      this.recentMints.delete(m);
    }
    return false;
  }

  private nextBackoffMs(): number {
    const { backoffMinMs, backoffMaxMs } = this.timing;
    const ceiling = Math.min(backoffMaxMs, backoffMinMs * 2 ** this.attempt);
    this.attempt++;
    // Equal jitter: half fixed, half random — avoids a thundering herd if
    // several instances drop at once, without ever retrying instantly.
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.running || this.reconnectTimer) return;
    this.stats.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || this.pongTimer) return;
      try {
        ws.ping();
      } catch {
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        LOG.warn("Blur stream: no pong — terminating half-open socket");
        ws.terminate();
      }, this.timing.pongTimeoutMs);
      this.pongTimer.unref();
    }, this.timing.pingIntervalMs);
    this.pingTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private alertOnce(message: string, details: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_COOLDOWN_MS) return;
    this.lastAlertAt = now;
    try {
      this.onFatal(message, details);
    } catch (err: any) {
      LOG.error({ err: err?.message }, "Blur stream alert hook threw");
    }
  }

  private logStats(): void {
    LOG.info(this.status(), "📊 Blur stream stats");
  }
}

/**
 * Starts the Blur stream if SOLAMI_BLUR_API_KEY is configured. Returns null
 * (and logs an error) if it isn't — with the webhooks gone, that means no
 * candidate discovery is running at all.
 */
export function startBlurStream(
  opts: BlurStreamOptions = {},
): BlurStream | null {
  const apiKey = opts.apiKey ?? ENV.SOLAMI_BLUR_API_KEY;
  if (!apiKey) {
    LOG.error(
      "SOLAMI_BLUR_API_KEY not set — Blur stream NOT started, no candidate discovery is running",
    );
    return null;
  }

  let stream: BlurStream;
  try {
    stream = new BlurStream({
      ...opts,
      apiKey,
      baseUrl: opts.baseUrl ?? ENV.SOLAMI_BLUR_WS_URL,
      dexes: opts.dexes ?? ENV.SOLAMI_BLUR_DEXES,
    });
  } catch (err: any) {
    // Only a malformed SOLAMI_BLUR_WS_URL can land here — a config error, not
    // something a retry loop would fix.
    LOG.error(
      { err: err?.message },
      "Invalid Blur stream configuration — no candidate discovery is running",
    );
    return null;
  }

  stream.start();
  return stream;
}

export default { startBlurStream, buildBlurUrl };
