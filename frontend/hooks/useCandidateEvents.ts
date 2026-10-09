// frontend/hooks/useCandidateEvents.ts
"use client";

import { useCallback, useState } from "react";
import { useSocket } from "./useSocket";
import { useSocketEvent } from "./useSocketEvent";

// What the bot is doing with newly discovered tokens, live.
//
// This replaces the "jupiter:*" events the dashboard used to listen for. The
// backend stopped sending those when discovery moved to the Blur stream, so the
// activity feed and its lists sat empty forever. The pipeline now reports on
// the "candidate:*" events (backend candidatePipeline.service.ts):
//
//   candidate:approved       passed every safety filter
//   candidate:filtered_out   failed a filter          (the bot passed on it)
//   candidate:not_tradeable  no usable Jupiter route  (the bot passed on it)
//   candidate:buy_success    the bot bought it for THIS wallet   (private)
//   candidate:buy_failed     the bot wanted it but this wallet couldn't (private)

export interface CandidateApproved {
  mint: string;
  passedFilters?: string[];
  at: number;
}

export interface CandidatePassedOn {
  mint: string;
  reason: string;
  failedFilters?: string[];
  at: number;
}

export interface CandidateBought {
  mint: string;
  signature?: string;
  tokensReceived?: number;
  actualPrice?: number;
  at: number;
}

export interface CandidateSkipped {
  mint: string;
  failedStageName?: string;
  reason: string;
  at: number;
}

// Newest first, one entry per mint (a token reported again moves to the top),
// capped so a busy stream can't grow memory without bound.
function pushUnique<T extends { mint: string }>(
  list: T[],
  entry: T,
  max: number
): T[] {
  return [entry, ...list.filter((e) => e.mint !== entry.mint)].slice(0, max);
}

export function useCandidateEvents() {
  const { connected } = useSocket();
  const [approved, setApproved] = useState<CandidateApproved[]>([]);
  const [passedOn, setPassedOn] = useState<CandidatePassedOn[]>([]);
  const [bought, setBought] = useState<CandidateBought[]>([]);
  const [skipped, setSkipped] = useState<CandidateSkipped[]>([]);

  useSocketEvent<{ mint?: string; passedFilters?: string[] }>(
    "candidate:approved",
    useCallback((p) => {
      if (!p?.mint) return;
      const entry: CandidateApproved = { mint: p.mint, at: Date.now() };
      if (p.passedFilters) entry.passedFilters = p.passedFilters;
      setApproved((prev) => pushUnique(prev, entry, 20));
      // If it was reported as passed-on a moment ago, it isn't any more.
      setPassedOn((prev) => prev.filter((e) => e.mint !== p.mint));
    }, [])
  );

  useSocketEvent<{ mint?: string; reason?: string; failedFilters?: string[] }>(
    ["candidate:filtered_out", "candidate:not_tradeable"],
    useCallback((p) => {
      if (!p?.mint) return;
      const entry: CandidatePassedOn = {
        mint: p.mint,
        reason: p.reason || "Did not meet the bot's criteria",
        at: Date.now(),
      };
      if (p.failedFilters) entry.failedFilters = p.failedFilters;
      setPassedOn((prev) => pushUnique(prev, entry, 50));
    }, [])
  );

  useSocketEvent<{
    mint?: string;
    signature?: string;
    tokensReceived?: number;
    actualPrice?: number;
  }>(
    "candidate:buy_success",
    useCallback((p) => {
      if (!p?.mint) return;
      const entry: CandidateBought = { mint: p.mint, at: Date.now() };
      if (p.signature) entry.signature = p.signature;
      if (p.tokensReceived != null) entry.tokensReceived = p.tokensReceived;
      if (p.actualPrice != null) entry.actualPrice = p.actualPrice;
      setBought((prev) => pushUnique(prev, entry, 20));
    }, [])
  );

  useSocketEvent<{
    mint?: string;
    failedStageName?: string;
    reason?: string;
  }>(
    "candidate:buy_failed",
    useCallback((p) => {
      if (!p?.mint) return;
      const entry: CandidateSkipped = {
        mint: p.mint,
        reason: p.reason || "Condition not met",
        at: Date.now(),
      };
      if (p.failedStageName) entry.failedStageName = p.failedStageName;
      setSkipped((prev) => pushUnique(prev, entry, 20));
    }, [])
  );

  return {
    connected,
    approved,
    passedOn,
    bought,
    skipped,
    latestBought: bought[0],
    latestSkipped: skipped[0],
    latestApproved: approved[0],
    latestPassedOn: passedOn[0],
  };
}

export default useCandidateEvents;
