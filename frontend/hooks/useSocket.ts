// frontend/hooks/useSocket.ts (update)
"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { Socket } from "socket.io-client";
import { socket } from "@lib/socket";

// Every event name this hook forwards into lastMessage, paired with how to
// shape the payload. Declared once at module scope (not per-render) so the
// handler functions built from it are stable across mounts.
const PASSTHROUGH_EVENTS = [
  "tradeFeed",
  "tokenFeed",
  "poolAvailable",
  "poolMonitorTimeout",
  "wallet:balance",
  "walletDeposit",
  "position:trailingUpdate",
  "tradeError",
  "jupiter:token_detected",
  "jupiter:token_skipped",
  "jupiter:validation_passed",
  "jupiter:validation_failed",
  "jupiter:pipeline_failed",
  "jupiter:pipeline_success",
  "pnl:update",
  // Portfolio-wide P&L (pnlBroadcaster.service.ts, every 30s) and per-token
  // breakdown — distinct event names from the per-position "pnl:update"
  // above, see pnlBroadcaster.service.ts for why they were split out.
  "portfolio:pnl:update",
  "pnl:tokens:update",
  // Price alerts (priceAlert.service.ts)
  "priceAlert:triggered",
  // Stored Token Checker Events
  "storedTokenChecker:status",
  "storedTokenChecker:qualified",
  // Watchlist (watchlist.route.ts) — broadcast after every add/remove so
  // useWatchlist.ts stays in sync across tabs without polling
  "watchlist:update",
  "globalAutoTrade:updated",
  // Set-alert doesn't re-broadcast the full list (unlike add/remove above),
  // so useWatchlist.ts refreshes on this instead of missing the update
  "priceAlert:set",
] as const;

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<any>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Attach to the shared singleton (frontend/lib/socket.ts) rather than
    // creating a new connection here — see that file for why.
    socketRef.current = socket;
    if (socket.connected) setConnected(true);

    // useSocket() is called from 20+ components simultaneously, all sharing
    // this one singleton socket. Handlers MUST be built fresh per mount and
    // torn down via the exact same function reference — an unqualified
    // socket.off("eventName") removes every listener for that event
    // (including every OTHER still-mounted component's), not just this
    // instance's, which used to mean any one consumer unmounting could
    // silently kill live updates for every other open panel until a full
    // page reload re-registered everything.
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: any) => console.error("socket err", err);
    const onUpdate = (data: any) => setLastMessage(data);
    // Dashboard stats — drives useStatsSync's live-update branch and the
    // performance chart's point-plotting, both of which were dead without this
    const onStatsUpdate = (data: any) =>
      setLastMessage({ event: "stats:update", payload: data?.payload ?? data });

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("update", onUpdate);
    socket.on("stats:update", onStatsUpdate);

    const passthroughHandlers = PASSTHROUGH_EVENTS.map((event) => {
      const handler = (data: any) => setLastMessage({ event, payload: data });
      socket.on(event, handler);
      return [event, handler] as const;
    });

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("update", onUpdate);
      socket.off("stats:update", onStatsUpdate);
      for (const [event, handler] of passthroughHandlers) {
        socket.off(event, handler);
      }
    };
  }, []);

  const sendMessage = useCallback((event: string, payload?: any) => {
    if (!socketRef.current) return;
    socketRef.current.emit(event, payload);
  }, []);

  const identify = useCallback((payload: any) => {
    if (!socketRef.current) return;
    socketRef.current.emit("identify", payload);
  }, []);

  return {
    connected,
    lastMessage,
    sendMessage,
    identify,
    socket: socketRef.current,
  };
}
export default useSocket;
