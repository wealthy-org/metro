import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bucketFor, ipFrom, ipKey, rateHeaders, retryAfterSeconds } from "./proxy.ts";

// The limiter's decision logic (Phase 12 D1): buckets, the IP source rule (F72) and the fail-open path, tested with a
// mocked Upstash Redis. Redis is never reached.

const state = { allow: true, remaining: 119, throwIt: false };

vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    async limit() {
      if (state.throwIt) throw new Error("redis down");
      return state.allow
        ? { success: true, limit: 120, remaining: state.remaining, reset: Date.now() + 30_000 }
        : { success: false, limit: 120, remaining: 0, reset: Date.now() + 5_000 };
    }
    static slidingWindow() {
      return "window";
    }
  },
}));

process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "token";
process.env.IP_HASH_SALT = "pepper";

const { proxy, LIMITS } = await import("./proxy.ts");

describe("bucketFor", () => {
  it("routes each path to its window and leaves the rest unlimited", () => {
    expect(bucketFor("/api/v1/stats", "GET")).toBe("api");
    expect(bucketFor("/api/v1/export/txs.csv", "GET")).toBe("api");
    expect(bucketFor("/api/lens/city/data", "GET")).toBe("api");
    expect(bucketFor("/api/inspector", "GET")).toBe("api");
    expect(bucketFor("/api/ask", "POST")).toBe("post");
    expect(bucketFor("/api/dispatch", "POST")).toBe("post");
    expect(bucketFor("/tx/0xabc", "GET")).toBe("page");
    expect(bucketFor("/token/0xabc", "GET")).toBe("page");
    expect(bucketFor("/wallet/0xabc", "GET")).toBe("page");
    expect(bucketFor("/api/health", "GET")).toBeNull();
    expect(bucketFor("/api/cron/insights", "GET")).toBeNull();
    expect(bucketFor("/api/ask", "GET")).toBeNull();
    expect(bucketFor("/", "GET")).toBeNull();
  });
});

describe("ipFrom", () => {
  it("prefers x-real-ip and never trusts a client-prepended x-forwarded-for entry", () => {
    expect(ipFrom(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(ipFrom(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(ipFrom(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(ipFrom(new Headers())).toBeNull();
  });

  it("hashes with the salt and stays stable", () => {
    expect(ipKey("203.0.113.9")).toHaveLength(32);
    expect(ipKey("203.0.113.9")).toBe(ipKey("203.0.113.9"));
    expect(ipKey("203.0.113.9")).not.toBe(ipKey("203.0.113.10"));
  });

  it("rounds Retry-After up and never below one second", () => {
    expect(retryAfterSeconds(Date.now() + 2_400)).toBe(3);
    expect(retryAfterSeconds(Date.now() - 5_000)).toBe(1);
  });

  it("publishes the standard rate headers", () => {
    expect(rateHeaders(120, 119, 30)).toEqual({ "RateLimit-Limit": "120", "RateLimit-Remaining": "119", "RateLimit-Reset": "30" });
    expect(rateHeaders(10, -1, 4)["RateLimit-Remaining"]).toBe("0");
  });
});

const request = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://metro.test${url}`, { method: init.method ?? "GET", headers: { "x-real-ip": "203.0.113.9", ...init.headers } });

describe("proxy", () => {
  beforeEach(() => {
    state.allow = true;
    state.remaining = 119;
    state.throwIt = false;
  });

  it("passes a request under the limit through with the rate headers", async () => {
    const res = await proxy(request("/api/v1/stats"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("ratelimit-limit")).toBe("120");
    expect(res.headers.get("ratelimit-remaining")).toBe("119");
  });

  it("blocks the over-limit API call with 429, Retry-After and a JSON error", async () => {
    state.allow = false;
    const res = await proxy(request("/api/v1/stats"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "rate limit exceeded" });
  });

  it("blocks an over-limit profile page with the 429 page", async () => {
    state.allow = false;
    const res = await proxy(request("/wallet/0xabc"));
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Too many requests from this address");
  });

  it("limits POST /api/ask in its own window", async () => {
    state.allow = false;
    const res = await proxy(request("/api/ask", { method: "POST" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("ratelimit-limit")).toBe(String(LIMITS.post));
  });

  it("fails open and logs when Redis is unreachable", async () => {
    state.throwIt = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await proxy(request("/api/v1/insights"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("leaves unlimited paths untouched", async () => {
    const res = await proxy(request("/api/health"));
    expect(res.headers.get("ratelimit-limit")).toBeNull();
  });

  it("warns once and passes when the limiter is not configured", async () => {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fresh = await import("./proxy.ts");
      const first = await fresh.proxy(request("/api/v1/stats"));
      const second = await fresh.proxy(request("/api/v1/stats"));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("not rate limited");
    } finally {
      process.env.UPSTASH_REDIS_REST_URL = url;
      process.env.UPSTASH_REDIS_REST_TOKEN = token;
      warn.mockRestore();
      vi.resetModules();
    }
  });
});
