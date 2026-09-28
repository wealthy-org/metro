// Terrain and Heatmap definitions shared by the server and the browser. Pure data only.

import { formatMetric, type CityMetric, type CityWindow } from "./city.ts";
import { formatGwei } from "./format.ts";
import type { Metric } from "./view-state.ts";

// Terrain time buckets per range (PROJECT.md 10.2). Every size divides a day, so buckets align on UTC midnight.
export const TERRAIN_BUCKETS: Record<CityWindow, { key: "1m" | "10m" | "1h" | "4h" | "1d"; ms: number; label: string }> = {
  "1h": { key: "1m", ms: 60_000, label: "1 minute" },
  "24h": { key: "10m", ms: 600_000, label: "10 minutes" },
  "7d": { key: "1h", ms: 3_600_000, label: "1 hour" },
  "30d": { key: "4h", ms: 14_400_000, label: "4 hours" },
  all: { key: "1d", ms: 86_400_000, label: "1 day" },
};
export type TerrainBucket = (typeof TERRAIN_BUCKETS)[CityWindow]["key"];
export const bucketMs = (key: TerrainBucket) => Object.values(TERRAIN_BUCKETS).find((b) => b.key === key)?.ms ?? 60_000;

// A heatmap cell: "d" has data, "n" is inside the window but nothing was ingested, "o" is outside the window.
export type CellState = "d" | "n" | "o";

export function formatValue(value: number | null, metric: Metric): string {
  if (metric === "gas_price") return value === null || !Number.isFinite(value) ? "—" : `${formatGwei(value)} Gwei`;
  return formatMetric(value, metric as CityMetric);
}

// "27 Sep 15:00", the prototype's time label.
export function timeLabel(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.toISOString().slice(11, 16)}`;
}
