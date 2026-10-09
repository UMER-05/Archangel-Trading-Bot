// frontend/lib/cryptoPolyfill.ts
//
// crypto.randomUUID() is only exposed in secure contexts (HTTPS, or
// localhost) — browsers withhold it entirely over plain HTTP. Several
// components call it directly (LiveTrades.tsx, AccountNotifications.tsx,
// live-feed.tsx, useTrade.ts), which crashed the whole app on first render
// when deployed over HTTP-only. crypto.getRandomValues() has no such
// restriction, so it's used here to build a spec-compliant (RFC 4122 v4)
// UUID as a drop-in fallback. Import this once, as early as possible in the
// client bundle (see app/layout.tsx).
if (
  typeof window !== "undefined" &&
  window.crypto &&
  typeof window.crypto.randomUUID !== "function"
) {
  (window.crypto as any).randomUUID = function randomUUID(): string {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  };
}

export {};
