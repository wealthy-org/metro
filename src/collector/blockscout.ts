import { BLOCKSCOUT_API, BLOCKSCOUT_PUBLIC_API } from "../../config/known-contracts.ts";
import { limitedFetch } from "./rate-limiter.ts";

type Fetch = typeof fetch;

const PUBLIC_RETRY_MS = 10 * 60_000;

export type BlockscoutOptions = {
  publicBase?: string;
  proBase?: string;
  apiKey?: string;
  publicFetch?: Fetch;
  proFetch?: Fetch;
};

export class BlockscoutError extends Error {}

// A public explorer answer that means "blocked", not "no data": bot challenge, auth or payment wall.
function isBlocked(res: Response): boolean {
  return res.status === 401 || res.status === 402 || res.status === 403 || res.headers.has("cf-mitigated");
}

// Blockscout API v2 (PROJECT.md 8.1). The public URL (BLOCKSCOUT_API_URL) is tried first; the PRO API with
// BLOCKSCOUT_API_KEY is used only when the public URL cannot be reached or is blocked.
export class Blockscout {
  private readonly publicBase: string;
  private readonly proBase: string;
  private readonly apiKey: string | undefined;
  private readonly publicFetch: Fetch;
  private readonly proFetch: Fetch;
  // While blocked, the public URL is retried every PUBLIC_RETRY_MS instead of on every call.
  private publicRetryAt = 0;

  constructor(opts: BlockscoutOptions = {}) {
    this.publicBase = (opts.publicBase ?? process.env.BLOCKSCOUT_API_URL ?? BLOCKSCOUT_PUBLIC_API).replace(/\/$/, "");
    this.proBase = (opts.proBase ?? BLOCKSCOUT_API).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? (process.env.BLOCKSCOUT_API_KEY || undefined);
    this.publicFetch = opts.publicFetch ?? limitedFetch("blockscout-public", 5);
    // PRO free tier allows 5 requests per second (docs.blockscout.com/rate-limits, 2026-09-27).
    this.proFetch = opts.proFetch ?? limitedFetch("blockscout-pro", 4);
  }

  get usingFallback(): boolean {
    return Date.now() < this.publicRetryAt;
  }

  async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const key = this.apiKey;
    if (!this.usingFallback) {
      const result = await this.tryPublic(path, query);
      if (result.ok) return result.body;
      // Only a block or a network/5xx failure switches to PRO; a normal HTTP error (404, 422) is a real answer.
      if (!result.fallback) throw new BlockscoutError(result.message);
      if (result.sticky) this.publicRetryAt = Date.now() + PUBLIC_RETRY_MS;
      if (!key) throw new BlockscoutError(`${result.message}; set BLOCKSCOUT_API_KEY to use the PRO API fallback`);
    } else if (!key) {
      throw new BlockscoutError("Public Blockscout is blocked and BLOCKSCOUT_API_KEY is not set");
    }
    return this.fetchPro(path, query, key);
  }

  private async tryPublic(
    path: string,
    query: Record<string, string>,
  ): Promise<{ ok: true; body: unknown } | { ok: false; fallback: boolean; sticky: boolean; message: string }> {
    let res: Response;
    try {
      res = await this.publicFetch(`${this.publicBase}${path}${toQuery(query)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      return { ok: false, fallback: true, sticky: false, message: `Public Blockscout unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (isBlocked(res)) return { ok: false, fallback: true, sticky: true, message: `Public Blockscout blocked (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, fallback: res.status >= 500, sticky: false, message: `Public Blockscout HTTP ${res.status} for ${path}` };
    const body: unknown = await res.json().catch(() => undefined);
    if (body === undefined) return { ok: false, fallback: true, sticky: true, message: "Public Blockscout returned non-JSON" };
    return { ok: true, body };
  }

  private async fetchPro(path: string, query: Record<string, string>, apiKey: string): Promise<unknown> {
    // Blockscout documents the key as the `apikey` query parameter. The URL is never logged because it carries the key.
    const res = await this.proFetch(`${this.proBase}${path}${toQuery({ ...query, apikey: apiKey })}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new BlockscoutError(`Blockscout PRO HTTP ${res.status} for ${path}`);
    return res.json();
  }
}

function toQuery(query: Record<string, string>): string {
  const params = new URLSearchParams(query).toString();
  return params ? `?${params}` : "";
}
