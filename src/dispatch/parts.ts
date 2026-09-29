// Report parts (PROJECT.md 14.3; Phase 11 D2): small pure builders the Dispatch needs. SVG drawn from the report's own
// facts, escaped, with no external assets, so a report made by the cron (no browser, PROJECT.md 6) still carries its
// pictures. Colors come from the prototype's cost scale (lib/city.ts).
import { formatMetric } from "../lib/city.ts";

export const fmtInt = (v: number) => v.toLocaleString("en-US");
export const fmtUsd = (v: number | null) => formatMetric(v, "avg_fee_usd");
export const fmtPct = (v: number | null, digits = 2) => (v === null ? "n/a" : `${(v * 100).toFixed(digits)}%`);

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}

const MONO = "font-family='JetBrains Mono,ui-monospace,monospace'";

// One bar per action, height by the value the report states (transactions per covered block or the action's share).
export function actionBarsSvg(rows: { label: string; value: number; text: string }[]): string {
  const w = 640;
  const h = 240;
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  const step = (w - 40) / Math.max(1, rows.length);
  const bars = rows
    .map((r, i) => {
      const bh = Math.max(2, (r.value / max) * 170);
      const x = 20 + i * step;
      const bw = Math.min(46, step - 18);
      return `<rect x="${x.toFixed(1)}" y="${(200 - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="#c8f04a" opacity="0.85"/>
  <text x="${(x + bw / 2).toFixed(1)}" y="${(196 - bh).toFixed(1)}" text-anchor="middle" fill="#e7e9ee" ${MONO} font-size="10">${escapeXml(r.text)}</text>
  <text x="${(x + bw / 2).toFixed(1)}" y="218" text-anchor="middle" fill="#8f97a8" ${MONO} font-size="10">${escapeXml(r.label.split(" ")[0] ?? r.label)}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Per action: ${escapeXml(rows.map((r) => `${r.label} ${r.text}`).join(", "))}">
  <rect width="${w}" height="${h}" fill="#0b0d12"/>
  ${bars}
  <line x1="12" x2="${w - 12}" y1="200" y2="200" stroke="#242a36"/>
</svg>`;
}

// 24 cells, one per UTC hour of the range; brightness by transactions.
export function hourGridSvg(hours: { hour: number; tx: number }[], max: number): string {
  const w = 640;
  const h = 120;
  const cw = (w - 24) / 24;
  const cells = hours
    .map((x, i) => {
      const t = max > 0 ? x.tx / max : 0;
      const fill = t === 0 ? "#151922" : `rgba(200,240,74,${(0.12 + 0.88 * t).toFixed(2)})`;
      return `<rect x="${(12 + i * cw).toFixed(1)}" y="18" width="${(cw - 2).toFixed(1)}" height="54" rx="2" fill="${fill}"/>
  ${i % 3 === 0 ? `<text x="${(12 + i * cw + (cw - 2) / 2).toFixed(1)}" y="88" text-anchor="middle" fill="#8f97a8" ${MONO} font-size="10">${String(x.hour).padStart(2, "0")}</text>` : ""}`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Transactions per UTC hour: ${escapeXml(hours.map((x) => `${x.hour}:00 ${x.tx}`).join(", "))}">
  <rect width="${w}" height="${h}" fill="#0b0d12"/>
  ${cells}
</svg>`;
}

// Before and after pairs for the subsidy report: grey before, lime after, one pair per series.
export function pairBarsSvg(series: { label: string; before: number | null; after: number | null; fmt: (v: number | null) => string }[]): string {
  const w = 640;
  const h = 200;
  const max = Math.max(1e-9, ...series.flatMap((s) => [s.before ?? 0, s.after ?? 0]));
  const step = (w - 40) / Math.max(1, series.length);
  const bars = series
    .map((s, i) => {
      const hb = ((s.before ?? 0) / max) * 110;
      const ha = ((s.after ?? 0) / max) * 110;
      const x = 24 + i * step;
      return `<rect x="${x.toFixed(1)}" y="${(150 - hb).toFixed(1)}" width="${Math.min(34, step / 2 - 6).toFixed(1)}" height="${hb.toFixed(1)}" fill="#3a4152"/>
  <rect x="${(x + Math.min(34, step / 2 - 6) + 4).toFixed(1)}" y="${(150 - ha).toFixed(1)}" width="${Math.min(34, step / 2 - 6).toFixed(1)}" height="${ha.toFixed(1)}" fill="#c8f04a"/>
  <text x="${(x + step / 2 - 4).toFixed(1)}" y="170" text-anchor="middle" fill="#8f97a8" ${MONO} font-size="10">${escapeXml(s.label)}</text>
  <text x="${(x + step / 2 - 4).toFixed(1)}" y="186" text-anchor="middle" fill="#e7e9ee" ${MONO} font-size="10">${escapeXml(`${s.fmt(s.before)} to ${s.fmt(s.after)}`)}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Before and after: ${escapeXml(series.map((s) => `${s.label} ${s.fmt(s.before)} to ${s.fmt(s.after)}`).join(", "))}">
  <rect width="${w}" height="${h}" fill="#0b0d12"/>
  ${bars}
  <line x1="12" x2="${w - 12}" y1="150" y2="150" stroke="#242a36"/>
</svg>`;
}
