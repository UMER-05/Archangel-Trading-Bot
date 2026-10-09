import { describe, it, expect } from "vitest";
import { callConfigApi, ConfigApiError } from "../configApi";

type FakeResponse = { ok: boolean; status: number; json: () => Promise<any> };

async function withFetch<T>(
  impl: () => Promise<FakeResponse>,
  run: () => Promise<T>
) {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = impl;
  try {
    return await run();
  } finally {
    (globalThis as any).fetch = original;
  }
}

async function failure(
  impl: () => Promise<FakeResponse>
): Promise<ConfigApiError> {
  try {
    await withFetch(impl, () => callConfigApi("http://x/y"));
  } catch (err) {
    return err as ConfigApiError;
  }
  throw new Error("expected callConfigApi to throw");
}

describe("callConfigApi", () => {
  it("returns the parsed body on success", async () => {
    const data = await withFetch(
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, config: { a: 1 } }),
      }),
      () => callConfigApi("http://x/y")
    );
    expect(data.config).toEqual({ a: 1 });
  });

  it("throws with the server's own message on a 400", async () => {
    const err = await failure(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: "takeProfitPct must be between 0 and 1",
      }),
    }));
    expect(err.message).toBe("takeProfitPct must be between 0 and 1");
    expect(err.status).toBe(400);
  });

  it("throws on success:false even when the HTTP status is 200", async () => {
    const err = await failure(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: false, message: "nope" }),
    }));
    expect(err.message).toBe("nope");
  });

  it("keeps the status so callers can treat a 404 as 'nothing to remove'", async () => {
    const err = await failure(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, error: "Configuration not found" }),
    }));
    expect(err.status).toBe(404);
  });

  it("falls back to the HTTP status when the body isn't JSON", async () => {
    const err = await failure(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    }));
    expect(err.message).toBe("Request failed (HTTP 502)");
  });

  it("explains an unreachable server in plain language", async () => {
    const err = await failure(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(err.message).toContain("Couldn't reach the ArchAngel server");
    expect(err.status).toBe(0);
  });
});
