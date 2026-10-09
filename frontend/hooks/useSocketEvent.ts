// frontend/hooks/useSocketEvent.ts
"use client";

import { useEffect, useRef } from "react";
import { socket } from "@lib/socket";

/**
 * Subscribe to one or more socket events and get EVERY occurrence.
 *
 * useSocket()'s `lastMessage` is a single slot: when two events land in the
 * same tick only the last one is seen, and only events on its PASSTHROUGH
 * list are forwarded at all (the candidate:* events never were). This hooks
 * straight onto the shared socket instead, so nothing is dropped and no
 * unrelated event re-renders the caller.
 *
 * The handler may change on every render without re-subscribing.
 */
export function useSocketEvent<T = any>(
  events: string | readonly string[],
  handler: (payload: T, event: string) => void
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  // A stable key so an inline array literal doesn't resubscribe every render.
  const key = typeof events === "string" ? events : events.join("|");

  useEffect(() => {
    const listeners = key.split("|").map((name) => {
      const listener = (payload: T) => handlerRef.current(payload, name);
      socket.on(name, listener);
      return { name, listener };
    });
    return () => {
      for (const { name, listener } of listeners) socket.off(name, listener);
    };
  }, [key]);
}

export default useSocketEvent;
