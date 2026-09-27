// Token-bucket rate limiting for every external call (PROJECT.md 9.4). One bucket per key, shared by the process.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private tokens: number;
  private last = performance.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(ratePerSecond: number, burst = Math.max(1, Math.ceil(ratePerSecond))) {
    if (!(ratePerSecond > 0)) throw new Error("ratePerSecond must be positive");
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.tokens = burst;
  }

  private refill(): void {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
  }

  // Resolves when a token is available; callers are served in arrival order.
  take(): Promise<void> {
    const turn = this.queue.then(async () => {
      this.refill();
      if (this.tokens < 1) {
        await sleep(((1 - this.tokens) / this.ratePerSecond) * 1000);
        this.refill();
      }
      this.tokens -= 1;
    });
    this.queue = turn;
    return turn;
  }
}

const limiters = new Map<string, RateLimiter>();

function limiterFor(key: string, ratePerSecond: number): RateLimiter {
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(ratePerSecond);
    limiters.set(key, limiter);
  }
  return limiter;
}

// fetch that waits for a token from the named bucket before each HTTP request.
export function limitedFetch(key: string, ratePerSecond: number): typeof fetch {
  const limiter = limiterFor(key, ratePerSecond);
  return async (input, init) => {
    await limiter.take();
    return fetch(input, init);
  };
}
