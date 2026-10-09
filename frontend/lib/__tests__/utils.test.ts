import { describe, it, expect, vi, afterEach } from "vitest";
import { fetcher, post, cn, formatNumber, truncateAddress, formatTime } from "../utils";

describe("fetcher", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("prefixes a relative URL with the configured backend URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, foo: "bar" }),
    });
    global.fetch = mockFetch as any;

    await fetcher("/api/stats");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toBe("http://localhost:4000/api/stats");
  });

  it("does not double-prefix an already-absolute URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = mockFetch as any;

    await fetcher("https://example.com/api/thing");

    expect(mockFetch.mock.calls[0][0]).toBe("https://example.com/api/thing");
  });

  it("throws when the backend responds with success: false", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, message: "nope" }),
    }) as any;

    await expect(fetcher("/api/x")).rejects.toThrow("nope");
  });

  it("throws a network error when fetch itself rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("fail")) as any;

    await expect(fetcher("/api/x")).rejects.toThrow(/Network error/);
  });

  it("throws on a non-JSON response body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    }) as any;

    await expect(fetcher("/api/x")).rejects.toThrow(/Invalid JSON/);
  });
});

describe("post", () => {
  it("sends the body as JSON via POST", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as any;

    await post("/api/thing", { a: 1 });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("POST");
    expect(options.body).toBe(JSON.stringify({ a: 1 }));

    global.fetch = originalFetch;
  });
});

describe("cn", () => {
  it("joins truthy class names with a space", () => {
    expect(cn("a", "b", undefined, false, null, "c")).toBe("a b c");
  });

  it("returns an empty string when nothing is truthy", () => {
    expect(cn(undefined, false, null)).toBe("");
  });
});

describe("formatNumber", () => {
  it("caps decimal places at the requested precision", () => {
    expect(formatNumber(1.23456, 2)).toBe("1.23");
  });

  it("adds thousands separators", () => {
    expect(formatNumber(1234567, 0)).toBe("1,234,567");
  });
});

describe("truncateAddress", () => {
  it("shortens a long address to an 8-char head + 4-char tail", () => {
    const addr = "So11111111111111111111111111111111111111112";
    expect(truncateAddress(addr)).toBe("So111111...1112");
  });

  it("returns an empty string for a falsy address", () => {
    expect(truncateAddress("")).toBe("");
  });
});

describe("formatTime", () => {
  it("formats both Date objects and date strings the same way", () => {
    const d = new Date("2026-01-01T12:34:56Z");
    expect(formatTime(d)).toBe(formatTime(d.toISOString()));
  });
});
