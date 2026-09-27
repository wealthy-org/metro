"use client";

import { cssColor, formatMetric, metricValue, type CityBuilding, type CityMetric } from "../../lib/city.ts";

// 2D stand-in for the City when WebGL is missing or its context was lost (PROJECT.md 19): the same buildings as
// horizontal bars, bar length = selected metric, color = fee. Each row opens the Inspector.
const ROW = 30;
const LABEL_W = 150;
const BAR_W = 420;
const VALUE_W = 90;

export function CityFallback({
  buildings,
  colors,
  metric,
  selectedIndex,
  onSelect,
}: {
  buildings: CityBuilding[];
  colors: [number, number, number][];
  metric: CityMetric;
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const values = buildings.map((b) => metricValue(b, metric));
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const width = LABEL_W + BAR_W + VALUE_W;

  return (
    <svg viewBox={`0 0 ${width} ${buildings.length * ROW}`} width={width} height={buildings.length * ROW} role="list" aria-label="City lens as bars">
      {buildings.map((b, i) => {
        const v = values[i] ?? null;
        const w = v === null || max === 0 ? 0 : Math.max(2, (v / max) * BAR_W);
        const y = i * ROW;
        const selected = i === selectedIndex;
        const activate = () => onSelect(i);
        return (
          <g
            key={`${b.kind}:${b.key}`}
            role="listitem"
            tabIndex={0}
            aria-label={`${b.label}: ${formatMetric(v, metric)}. Inspect`}
            className="cursor-pointer outline-none focus-visible:[&>rect:first-child]:stroke-accent"
            onClick={activate}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            }}
          >
            <rect x={0} y={y + 2} width={width} height={ROW - 4} rx={2} fill={selected ? "#151922" : "transparent"} stroke="transparent" strokeWidth={1} />
            <text x={8} y={y + ROW / 2 + 4} className={selected ? "fill-accent" : "fill-text"} fontSize={12}>
              {b.kind === "token" ? `${b.label} (Pons)` : b.label}
            </text>
            <rect x={LABEL_W} y={y + 8} width={w} height={ROW - 16} rx={1} fill={cssColor(colors[i] ?? [0.23, 0.25, 0.32])} />
            <text x={LABEL_W + BAR_W + 8} y={y + ROW / 2 + 4} className="fill-text font-mono" fontSize={11}>
              {formatMetric(v, metric)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
