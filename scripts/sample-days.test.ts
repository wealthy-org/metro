import { describe, expect, it } from "vitest";
import { yesterdayUtc } from "./sample-days.ts";

// Phase 14: the cron entry samples the last complete UTC day. A day is only sampled after it has ended, so the date
// must roll back across month and year boundaries in UTC (not local time).

describe("yesterdayUtc", () => {
  it("returns the previous UTC day", () => {
    expect(yesterdayUtc(new Date("2026-09-30T05:55:00Z"))).toBe("2026-09-29");
  });

  it("rolls back across a month boundary just after midnight UTC", () => {
    expect(yesterdayUtc(new Date("2026-10-01T00:10:00Z"))).toBe("2026-09-30");
  });

  it("rolls back across a year boundary", () => {
    expect(yesterdayUtc(new Date("2027-01-01T01:30:00Z"))).toBe("2026-12-31");
  });

  it("rolls back across a non-leap February", () => {
    expect(yesterdayUtc(new Date("2026-03-01T01:30:00Z"))).toBe("2026-02-28");
  });
});
