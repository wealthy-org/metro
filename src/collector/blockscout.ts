import { BLOCKSCOUT_PUBLIC_API } from "../../config/known-contracts.ts";
import { limitedFetch } from "./rate-limiter.ts";

// Blockscout API v2 (PROJECT.md 8.1) through BLOCKSCOUT_API_URL only (PROJECT.md 23; audit A2, 2026-09-28).
// The explorer is a shared public service, so every call passes one guard layer:
// 1. Rate limit: at most RATE_PER_SECOND requests from this process.
// 2. Server hints: when X-RateLimit-Remaining is nearly spent, calls wait for X-RateLimit-Reset (milliseconds, per
//    Blockscout's rate_limits.md); a 429 waits for Retry-After.
// 3. Cache: each path and query is cached for the caller's TTL; concurrent callers share one request.
// 4. Circuit breaker: a block (401/402/403 or a Cloudflare challenge), a non-JSON body, or failures that remain after
//    the retries stop all calls for OPEN_MS. Callers then get BlockscoutUnavailable with the last good value.
// 5. Retry: network errors, timeouts, 429 and 5xx are retried with exponential backoff before the breaker opens.
// 6. Validation: a caller-supplied check rejects a body of the wrong shape, which is never cached.
// Metro never tries to get around the explorer's bot protection; a block means "unavailable".

type Fetch = typeof fetch;

const RATE_PER_SECOND = 2;
const TIMEOUT_MS = 15_000;
const OPEN_MS = 10 * 60_000;
const RETRIES = 2;
const BACKOFF_MS = 500;
const MAX_WAIT_MS = 30_000;
const MAX_CACHE = 200;
export const DEFAULT_TTL_MS = 5 * 60_000;

export class BlockscoutError extends Error {}

// The explorer cannot be used right now. `stale` carries the last good body for this request, if any.
export class BlockscoutUnavailable extends Error {
  readonly until: number;
  readonly stale: { value: unknown; at: number } | null;
  constructor(message: string, until: number, stale: { value: unknown; at: number } | null) {
    super(message);
    this.until = until;
    this.stale = stale;
  }
}

export type BlockscoutOptions = {
  base?: string;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type GetOptions = {
  query?: Record<string, string>;
  ttlMs?: number;
  validate?: (body: unknown) => boolean;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isBlocked(res: Response): boolean {
  return res.status === 401 || res.status === 402 || res.status === 403 || res.headers.has("cf-mitigated");
}

// Header numbers; -1 or a missing header means "unknown" (Blockscout rate_limits.md).
function headerNumber(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export class Blockscout {
  private readonly base: string;
  private readonly fetchFn: Fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, { value: unknown; at: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private openUntil = 0;
  private openReason = "";
  private pauseUntil = 0;

  constructor(opts: BlockscoutOptions = {}) {
    this.base = (opts.base ?? process.env.BLOCKSCOUT_API_URL ?? BLOCKSCOUT_PUBLIC_API).replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? limitedFetch("blockscout", RATE_PER_SECOND);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  // True while the breaker is open.
  get unavailable(): boolean {
    return this.now() < this.openUntil;
  }

  async get(path: string, opts: GetOptions = {}): Promise<unknown> {
    const url = `${this.base}${path}${toQuery(opts.query ?? {})}`;
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    const cached = this.cache.get(url);
    if (cached && this.now() - cached.at < ttl) return cached.value;
    if (this.unavailable) throw new BlockscoutUnavailable(this.openReason, this.openUntil, cached ?? null);
    let pending = this.inflight.get(url);
    if (!pending) {
      pending = this.request(url, path, opts.validate).finally(() => this.inflight.delete(url));
      this.inflight.set(url, pending);
    }
    return pending;
  }

  private trip(reason: string, url: string): never {
    this.openUntil = this.now() + OPEN_MS;
    this.openReason = reason;
    throw new BlockscoutUnavailable(reason, this.openUntil, this.cache.get(url) ?? null);
  }

  private remember(url: string, value: unknown): void {
    this.cache.delete(url);
    this.cache.set(url, { value, at: this.now() });
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async request(url: string, path: string, validate?: (body: unknown) => boolean): Promise<unknown> {
    let lastProblem = "";
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      const wait = this.pauseUntil - this.now();
      if (wait > 0) await this.sleep(Math.min(wait, MAX_WAIT_MS));
      const backoff = BACKOFF_MS * 2 ** attempt;

      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        lastProblem = `Blockscout unreachable: ${err instanceof Error ? err.name : "error"}`;
        if (attempt < RETRIES) await this.sleep(backoff);
        continue;
      }

      const remaining = headerNumber(res, "x-ratelimit-remaining");
      const reset = headerNumber(res, "x-ratelimit-reset");
      if (remaining !== null && remaining <= 1 && reset !== null) this.pauseUntil = this.now() + Math.min(reset, MAX_WAIT_MS);

      if (isBlocked(res)) this.trip(`Blockscout blocked the request (HTTP ${res.status})`, url);
      if (res.status === 429 || res.status >= 500) {
        lastProblem = `Blockscout HTTP ${res.status}`;
        const retryAfter = headerNumber(res, "retry-after");
        const delay = res.status === 429 ? (retryAfter !== null ? retryAfter * 1000 : (reset ?? backoff)) : backoff;
        if (attempt < RETRIES) await this.sleep(Math.min(delay, MAX_WAIT_MS));
        continue;
      }
      // A normal HTTP error (404, 422) is a real answer about this request, not about the service.
      if (!res.ok) throw new BlockscoutError(`Blockscout HTTP ${res.status} for ${path}`);

      const body: unknown = await res.json().catch(() => undefined);
      if (body === undefined) this.trip("Blockscout returned a non-JSON answer", url);
      if (validate && !validate(body)) throw new BlockscoutError(`Blockscout answer for ${path} has an unexpected shape`);
      this.remember(url, body);
      return body;
    }
    this.trip(lastProblem || "Blockscout failed", url);
  }
}

let shared: Blockscout | null = null;
// One client per process, so the rate limit, cache and breaker cover every caller.
export const sharedBlockscout = () => (shared ??= new Blockscout());

function toQuery(query: Record<string, string>): string {
  const params = new URLSearchParams(query).toString();
  return params ? `?${params}` : "";
}
