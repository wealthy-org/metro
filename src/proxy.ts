import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Per-IP rate limits (PROJECT.md 16, 19; Phase 12 D1, KL-31). The sliding windows live in the Phase 10 Upstash Redis.
// The client IP comes only from the headers Vercel sets (x-real-ip, else the last x-forwarded-for entry), the same rule
// as src/server/ask-limit.ts (gate F72); an entry a client put at the front is never trusted. When Redis cannot be
// reached every request passes and the failure is logged (fail open, D1).

export type Bucket = "api" | "post" | "page";

export const LIMITS: Record<Bucket, number> = { api: 120, post: 10, page: 120 };
const WINDOW = "60 s";

// Which request counts against which window. The profile pages read RPC per unique request, so they get their own
// bucket: their page views never consume the API budget (D3). /api/health and /api/cron/* are not limited.
export function bucketFor(pathname: string, method: string): Bucket | null {
  if (pathname === "/api/inspector" || pathname.startsWith("/api/v1/") || pathname.startsWith("/api/lens/")) return "api";
  if (method === "POST" && (pathname === "/api/ask" || pathname === "/api/dispatch")) return "post";
  if (pathname.startsWith("/tx/") || pathname.startsWith("/token/") || pathname.startsWith("/wallet/")) return "page";
  return null;
}

export function ipFrom(headers: Headers): string | null {
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = (headers.get("x-real-ip") ?? "").trim() || forwarded.at(-1) || "";
  return ip || null;
}

export function ipKey(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? "";
  return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32);
}

export function retryAfterSeconds(resetMs: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((resetMs - now) / 1000));
}

export function rateHeaders(limit: number, remaining: number, retrySeconds: number): Record<string, string> {
  return { "RateLimit-Limit": String(limit), "RateLimit-Remaining": String(Math.max(0, remaining)), "RateLimit-Reset": String(retrySeconds) };
}

export type LimitOutcome = { success: boolean; limit: number; remaining: number; reset: number };
export type Limiter = { limit: (key: string) => Promise<LimitOutcome> };

// Thin seam so tests can pass a limiter that allows, denies or throws; a throw is handled by the caller as fail open.
export async function checkLimit(limiter: Limiter, key: string): Promise<LimitOutcome> {
  return await limiter.limit(key);
}

let limiters: Record<Bucket, Limiter> | null | undefined;

function getLimiters(): Record<Bucket, Limiter> | null {
  if (limiters !== undefined) return limiters;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // The memo makes this warning fire once per process; fail open stays the behavior (D1).
    console.warn(JSON.stringify({ msg: "rate limiter not configured (UPSTASH_REDIS_REST_URL/TOKEN missing); requests are not rate limited" }));
    limiters = null;
    return null;
  }
  const redis = new Redis({ url, token });
  limiters = {
    api: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(LIMITS.api, WINDOW), prefix: "metro:rl:api" }),
    post: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(LIMITS.post, WINDOW), prefix: "metro:rl:post" }),
    page: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(LIMITS.page, WINDOW), prefix: "metro:rl:page" }),
  };
  return limiters;
}

function htmlPage(retrySeconds: number): string {
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Too many requests, Metro</title>",
    "<style>body{margin:0;background:#0b0d12;color:#e7e9ee;font:14px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:420px;padding:24px;text-align:center}a{color:#c8f04a}</style></head>",
    `<body><main><h1 style="font-size:22px;margin:0 0 8px">Too many requests</h1><p>Too many requests from this address. Try again in ${retrySeconds} seconds.</p><p><a href="/">Back to Metro</a></p></main></body></html>`,
  ].join("");
}

function blocked(bucket: Bucket, retrySeconds: number): NextResponse {
  const headers = { ...rateHeaders(LIMITS[bucket], 0, retrySeconds), "Retry-After": String(retrySeconds), "cache-control": "no-store" };
  if (bucket === "page") return new NextResponse(htmlPage(retrySeconds), { status: 429, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  return NextResponse.json({ error: "rate limit exceeded", retry_after: retrySeconds }, { status: 429, headers });
}

export async function proxy(request: NextRequest) {
  const bucket = bucketFor(request.nextUrl.pathname, request.method);
  if (!bucket) return NextResponse.next();
  const all = getLimiters();
  if (!all) return NextResponse.next();
  const ip = ipFrom(request.headers);
  if (!ip) return NextResponse.next();
  try {
    const outcome = await checkLimit(all[bucket], ipKey(ip));
    const retry = retryAfterSeconds(outcome.reset);
    if (!outcome.success) return blocked(bucket, retry);
    const response = NextResponse.next();
    for (const [k, v] of Object.entries(rateHeaders(outcome.limit, outcome.remaining, retry))) response.headers.set(k, v);
    return response;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "rate limiter unavailable; failing open", error: String(err).slice(0, 160) }));
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/api/v1/:path*", "/api/lens/:path*", "/api/inspector", "/api/ask", "/api/dispatch", "/tx/:path*", "/token/:path*", "/wallet/:path*"],
};
