import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.ts";

describe("RateLimiter (PROJECT.md 9.4)", () => {
  it("lets a burst through, then spaces calls at the configured rate", async () => {
    const limiter = new RateLimiter(20, 2);
    const started = performance.now();
    for (let i = 0; i < 6; i++) await limiter.take();
    // 2 immediate tokens, then 4 more at 20/s = at least ~200 ms.
    expect(performance.now() - started).toBeGreaterThanOrEqual(180);
  });

  it("serves concurrent callers without exceeding the rate", async () => {
    const limiter = new RateLimiter(50, 1);
    const started = performance.now();
    await Promise.all(Array.from({ length: 6 }, () => limiter.take()));
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new RateLimiter(0)).toThrow();
  });
});
