import { describe, expect, it } from "vitest";
import { change, points } from "../components/subsidy/SubsidyParts.tsx";
import { defaultWindows, parseWindow, windowParam } from "./subsidy.ts";

// Subsidy Cliff windows and change formatting (PROJECT.md 10.7, 11.4; Phase 8).
describe("subsidy windows", () => {
  it("defaults to 7 days either side of the end date", () => {
    const d = defaultWindows(new Date("2026-09-29T00:00:00Z"));
    expect(windowParam(d.before)).toBe("2026-09-22..2026-09-28");
    expect(windowParam(d.after)).toBe("2026-09-29..2026-10-05");
    expect(d.after.end.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("parses inclusive UTC days and rejects bad or long windows", () => {
    const w = parseWindow("2026-09-22..2026-09-28");
    expect(w).toEqual({ start: new Date("2026-09-22T00:00:00Z"), end: new Date("2026-09-29T00:00:00Z") });
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow("")).toBeNull();
    expect(parseWindow("2026-09-28..2026-09-22")).toBe("a window covers 1 to 31 days");
    expect(parseWindow("2026-08-01..2026-09-28")).toBe("a window covers 1 to 31 days");
    expect(parseWindow("2026-02-30..2026-03-02")).toBe("a window is YYYY-MM-DD..YYYY-MM-DD");
    expect(parseWindow("yesterday")).toBe("a window is YYYY-MM-DD..YYYY-MM-DD");
  });
});

describe("change and points", () => {
  it("states relative change with its direction, and n/a without both sides", () => {
    expect(change(20, 18)).toEqual({ text: "-10.0%", tone: "down" });
    expect(change(20, 23)).toEqual({ text: "+15.0%", tone: "up" });
    expect(change(20, 20)).toEqual({ text: "0.0%", tone: "flat" });
    expect(change(null, 3)).toEqual({ text: "n/a", tone: "none" });
    expect(change(0, 3)).toEqual({ text: "n/a", tone: "none" });
  });

  it("states share changes in percentage points", () => {
    expect(points(0.9995, 0.9)).toBe("-10.0 pt");
    expect(points(null, 0.5)).toBe("n/a");
  });
});
