import { describe, expect, it } from "vitest";
import { Blockscout, BlockscoutError, BlockscoutUnavailable } from "./blockscout.ts";

// Guard layer of the Blockscout client (PROJECT.md 8.1, 9.4, 23; audit A2). No network: fetch, clock and sleep are fakes.

function harness(responses: (Response | Error)[]) {
  let t = 1_000_000;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const bs = new Blockscout({
    base: "https://explorer.example/api/v2/",
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    fetch: async (input) => {
      calls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { bs, calls, sleeps, advance: (ms: number) => (t += ms) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const challenge = () => new Response("<html>Just a moment...</html>", { status: 403, headers: { "cf-mitigated": "challenge" } });

describe("Blockscout client guard layer", () => {
  it("reads BLOCKSCOUT_API_URL paths and caches each request for its TTL", async () => {
    const h = harness([json({ total_blocks: "1" }), json({ total_blocks: "2" })]);
    expect(await h.bs.get("/stats", { ttlMs: 60_000 })).toEqual({ total_blocks: "1" });
    expect(await h.bs.get("/stats", { ttlMs: 60_000 })).toEqual({ total_blocks: "1" });
    expect(h.calls).toEqual(["https://explorer.example/api/v2/stats"]);
    h.advance(60_000);
    expect(await h.bs.get("/stats", { ttlMs: 60_000 })).toEqual({ total_blocks: "2" });
  });

  it("shares one request between concurrent callers", async () => {
    const h = harness([json({ ok: 1 })]);
    const [a, b] = await Promise.all([h.bs.get("/tokens", { query: { type: "ERC-20" } }), h.bs.get("/tokens", { query: { type: "ERC-20" } })]);
    expect(a).toEqual(b);
    expect(h.calls).toEqual(["https://explorer.example/api/v2/tokens?type=ERC-20"]);
  });

  it("rejects and does not cache a body of the wrong shape; a 404 is an answer, not an outage", async () => {
    const h = harness([json({ nope: true }), json({ message: "not found" }, 404), json({ items: [] })]);
    const validate = (b: unknown) => typeof b === "object" && b !== null && "items" in b;
    await expect(h.bs.get("/blocks", { validate })).rejects.toBeInstanceOf(BlockscoutError);
    await expect(h.bs.get("/tokens/0x0")).rejects.toThrow("HTTP 404");
    expect(h.bs.unavailable).toBe(false);
    expect(await h.bs.get("/blocks", { validate })).toEqual({ items: [] });
  });

  it("opens the breaker on a block and serves nothing new for 10 minutes, with the last good value", async () => {
    const h = harness([json({ v: 1 }), challenge(), json({ v: 3 })]);
    await h.bs.get("/stats", { ttlMs: 1_000 });
    h.advance(1_000);
    const err = await h.bs.get("/stats", { ttlMs: 1_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockscoutUnavailable);
    expect((err as BlockscoutUnavailable).stale?.value).toEqual({ v: 1 });
    expect(h.bs.unavailable).toBe(true);
    // No request while open.
    await expect(h.bs.get("/blocks")).rejects.toBeInstanceOf(BlockscoutUnavailable);
    expect(h.calls).toHaveLength(2);
    h.advance(10 * 60_000);
    expect(await h.bs.get("/stats", { ttlMs: 1_000 })).toEqual({ v: 3 });
  });

  it("treats a non-JSON answer as unavailable", async () => {
    const h = harness([new Response("<html>maintenance</html>", { status: 200 })]);
    await expect(h.bs.get("/stats")).rejects.toBeInstanceOf(BlockscoutUnavailable);
  });

  it("retries 5xx and network errors with backoff, then opens the breaker", async () => {
    const h = harness([json({}, 502), new Error("ECONNRESET"), json({}, 503)]);
    await expect(h.bs.get("/stats")).rejects.toThrow("HTTP 503");
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1000]);
    expect(h.bs.unavailable).toBe(true);
  });

  it("waits for Retry-After on 429 and succeeds on the retry", async () => {
    const h = harness([json({}, 429, { "retry-after": "2" }), json({ ok: true })]);
    expect(await h.bs.get("/stats")).toEqual({ ok: true });
    expect(h.sleeps).toEqual([2000]);
  });

  it("pauses for X-RateLimit-Reset (milliseconds) when the server budget is nearly spent", async () => {
    const h = harness([json({ a: 1 }, 200, { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "434" }), json({ b: 2 }, 200, { "x-ratelimit-remaining": "-1", "x-ratelimit-reset": "-1" })]);
    await h.bs.get("/stats");
    await h.bs.get("/blocks");
    expect(h.sleeps).toEqual([434]);
  });
});
