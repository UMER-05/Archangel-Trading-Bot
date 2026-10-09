// frontend/lib/configApi.ts
//
// fetch + JSON + "did it actually work" for the trader-config endpoints.
// Kept free of React/socket imports so it can be unit-tested on its own.

export class ConfigApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ConfigApiError";
    this.status = status;
  }
}

/**
 * Throws a ConfigApiError carrying the backend's own message for any non-2xx
 * or `success: false` response, and a plain-language one if the server can't
 * be reached at all. Every write goes through this so a failed save can never
 * look like a successful one.
 */
export async function callConfigApi(
  url: string,
  init?: RequestInit
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ConfigApiError(
      "Couldn't reach the ArchAngel server — check your connection and try again.",
      0
    );
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body: fall through to the status-based message below.
  }

  if (!res.ok || !data?.success) {
    throw new ConfigApiError(
      data?.error || data?.message || `Request failed (HTTP ${res.status})`,
      res.status
    );
  }
  return data;
}
