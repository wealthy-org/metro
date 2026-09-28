import type { ReactNode } from "react";
import type { WindowFigures } from "../../engine/subsidy.ts";
import type { SubsidyResponse } from "../../server/subsidy.ts";
import { actionLabel, formatMetric } from "../../lib/city.ts";
import { NA, formatCountCompact, formatDay } from "../../lib/format.ts";

// Before vs after parts shared by /subsidy and the Split lens (PROJECT.md 10.7, 12.4; prototype renderSplit). Pure
// components: no hooks, so a server page and a client lens render the same markup. Figures are rates over the
// covered blocks (Phase 8 D1); a change is colored as in the prototype (red down, teal up) and never called good or bad.

const int = new Intl.NumberFormat("en-US");
export const usd = (v: number | null) => formatMetric(v, "avg_fee_usd");
export const share = (v: number | null, digits = 1) => (v === null ? NA : `${(v * 100).toFixed(digits)}%`);
export const perBlock = (v: number | null) => (v === null ? NA : v.toFixed(2));

export function change(before: number | null, after: number | null): { text: string; tone: "up" | "down" | "flat" | "none" } {
  if (before === null || after === null || before === 0) return { text: NA, tone: "none" };
  const c = (after - before) / before;
  if (Math.abs(c) < 0.0005) return { text: "0.0%", tone: "flat" };
  return { text: `${c > 0 ? "+" : ""}${(c * 100).toFixed(1)}%`, tone: c > 0 ? "up" : "down" };
}

// Share changes in percentage points, for paid share and composition.
export function points(before: number | null, after: number | null): string {
  if (before === null || after === null) return NA;
  const p = (after - before) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(1)} pt`;
}

const toneClass = { up: "text-c0", down: "text-c2", flat: "text-mute", none: "text-mute" } as const;
const th = "border-b border-line px-1.5 py-1.5 text-right text-[10px] font-medium tracking-[0.08em] text-mute uppercase";
const td = "border-b border-line px-1.5 py-[7px] text-right font-mono";

// "Incomplete: N of M days" (PROJECT.md 10.7, AT 12), and the sampling note (KL-28).
export function CoverageNote({ data }: { data: SubsidyResponse }) {
  const { before, after } = data;
  const lines: string[] = [];
  if (after.days_with_data === 0) lines.push(`No block after ${formatDay(data.cliff_date)} is ingested yet, so the after window is empty.`);
  else if (after.days_ended < after.days_total) lines.push(`After window is incomplete: ${after.days_ended} of ${after.days_total} days. Figures can still move.`);
  if (before.days_ended < before.days_total && before.days_with_data > 0) lines.push(`Before window is incomplete: ${before.days_ended} of ${before.days_total} days.`);
  if (before.sampled || after.sampled) {
    const cov = (w: WindowFigures) => (w.coverage === null ? NA : `${int.format(w.blocks_covered)} blocks (${(w.coverage * 100).toFixed(2)}%)`);
    const rest =
      after.blocks_covered === 0 ? `${cov(before)} of the before window; the after window has no block yet` : before.blocks_covered === 0 ? `${cov(after)} of the after window; the before window has no block yet` : `${cov(before)} before and ${cov(after)} after`;
    lines.push(`Sampled: every figure rests on ${rest}. Each UTC day is 12 slices of 30 blocks. Rates and shares hold; totals are estimates.`);
  }
  if (!lines.length) return null;
  return (
    <div role="status" className="my-3 rounded-[3px] border border-c1 px-[11px] py-2 text-[12px] text-c1">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

type Col = { head: string; title?: string; cell: (b: WindowFigures["actions"][number] | WindowFigures, a: WindowFigures["actions"][number] | WindowFigures) => ReactNode };

// The composition share of the "All actions" row is 100% of whatever the window holds, and n/a when it holds nothing.
const shareCell = (w: WindowFigures["actions"][number] | WindowFigures) => ("share" in w ? share(w.share) : w.tx > 0 ? "100%" : NA);

// The sample of every row, shown in the table itself (PROJECT.md 12.4, gate F54).
const COLUMNS: Record<"compact" | "full", Col[]> = {
  compact: [
    { head: "Tx / block, before", title: "Transactions per covered block", cell: (b) => perBlock(b.tx_per_block) },
    { head: "Tx / block, after", cell: (_, a) => perBlock(a.tx_per_block) },
    { head: "Change", cell: (b, a) => <Change c={change(b.tx_per_block, a.tx_per_block)} /> },
    { head: "Paid share, before", title: "Estimate; ArbOS internal transactions left out", cell: (b) => share(b.paid_share) },
    { head: "Paid share, after", cell: (_, a) => share(a.paid_share) },
    { head: "Avg fee, before", cell: (b) => usd(b.avg_fee_usd) },
    { head: "Avg fee, after", cell: (_, a) => usd(a.avg_fee_usd) },
    { head: "n, before / after", title: "Transactions in the covered blocks", cell: (b, a) => `${int.format(b.tx)} / ${int.format(a.tx)}` },
  ],
  full: [],
};
COLUMNS.full = [
  { head: "n, before", title: "Transactions in the covered blocks", cell: (b) => int.format(b.tx) },
  { head: "n, after", cell: (_, a) => int.format(a.tx) },
  ...COLUMNS.compact.slice(0, 3),
  { head: "Share, before", title: "Part of all transactions (composition)", cell: (b) => shareCell(b) },
  { head: "Share, after", cell: (_, a) => shareCell(a) },
  ...COLUMNS.compact.slice(3, 7),
  { head: "Median fee, before", cell: (b) => usd(b.median_fee_usd) },
  { head: "Median fee, after", cell: (_, a) => usd(a.median_fee_usd) },
];

function Change({ c }: { c: ReturnType<typeof change> }) {
  return <span className={toneClass[c.tone]}>{c.text}</span>;
}

// One row per PROJECT.md 10.1 action type and an "All actions" row, with n in each row's title.
export function CompareTable({ data, columns = "compact", selected, onSelect }: { data: SubsidyResponse; columns?: "compact" | "full"; selected?: string | null; onSelect?: (key: string) => void }) {
  const cols = COLUMNS[columns];
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr>
          <th scope="col" className={`${th} text-left`}>
            Action
          </th>
          {cols.map((c) => (
            <th key={c.head} scope="col" title={c.title} className={th}>
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.before.actions.map((b, i) => {
          const a = data.after.actions[i] ?? b;
          const on = selected === b.key;
          const bg = on ? "bg-panel2" : onSelect ? "group-hover:bg-panel2" : "";
          return (
            <tr
              key={b.key}
              className={onSelect ? "group cursor-pointer" : undefined}
              aria-current={on ? "true" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(b.key) : undefined}
              onKeyDown={
                onSelect
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(b.key);
                      }
                    }
                  : undefined
              }
              title={`n = ${int.format(b.tx)} before, ${int.format(a.tx)} after`}
            >
              <td className={`border-b border-line px-1.5 py-[7px] text-left ${bg} ${on ? "text-accent" : ""}`}>{actionLabel(b.key)}</td>
              {cols.map((c) => (
                <td key={c.head} className={`${td} ${bg}`}>
                  {c.cell(b, a)}
                </td>
              ))}
            </tr>
          );
        })}
        <tr title={`n = ${int.format(data.before.tx)} before, ${int.format(data.after.tx)} after`}>
          <td className="border-b border-line px-1.5 py-[7px] text-left font-medium">All actions</td>
          {cols.map((c) => (
            <td key={c.head} className={`${td} font-medium`}>
              {c.cell(data.before, data.after)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

// Short names under the bars, so seven fit a phone-width chart; the chart's accessible name has the full ones.
const SHORT: Record<string, string> = { launch: "Launch", contract_call: "Call" };

// Before and after bars per action, grey before and lime after (prototype renderSplit, landing lines 266-269 and
// 464), shared by /subsidy, Split and the landing (gate F65). The bars stretch with the box and the action names are
// HTML under them, so the text keeps its size on a phone (gate F58).
export function BeforeAfterBars({ data, metric, height = 170, caption = true }: { data: SubsidyResponse; metric: "avg_fee_usd" | "tx_per_block"; height?: number; caption?: boolean }) {
  const pairs = data.before.actions.map((b, i) => ({ key: b.key, b: b[metric], a: data.after.actions[i]?.[metric] ?? null }));
  const max = Math.max(1e-9, ...pairs.flatMap((p) => [p.b ?? 0, p.a ?? 0]));
  const fmt = (v: number | null) => (metric === "avg_fee_usd" ? usd(v) : perBlock(v));
  const what = metric === "avg_fee_usd" ? "Average fee per transaction, USD" : "Transactions per block";
  return (
    <figure>
      <svg
        viewBox={`0 0 ${pairs.length * 100} 100`}
        preserveAspectRatio="none"
        style={{ height }}
        className="block w-full"
        role="img"
        aria-label={`${what}, before and after: ${pairs.map((p) => `${actionLabel(p.key)} ${fmt(p.b)} before, ${fmt(p.a)} after`).join("; ")}`}
      >
        {pairs.map((p, i) => {
          const hb = ((p.b ?? 0) / max) * 96;
          const ha = ((p.a ?? 0) / max) * 96;
          return (
            <g key={p.key}>
              <rect x={i * 100 + 18} y={100 - hb} width={30} height={hb} fill="#3a4152" />
              <rect x={i * 100 + 52} y={100 - ha} width={30} height={ha} fill="#c8f04a" />
            </g>
          );
        })}
        <line x1={0} x2={pairs.length * 100} y1={100} y2={100} stroke="#242a36" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 grid" style={{ gridTemplateColumns: `repeat(${pairs.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {pairs.map((p) => (
          <span key={p.key} className="text-center font-mono text-[10px] leading-tight text-mute">
            {SHORT[p.key] ?? actionLabel(p.key).split(" ")[0]}
          </span>
        ))}
      </div>
      {caption ? <figcaption className="mt-2 text-[12px] text-mute">Grey is before, lime is after. {what}, over the covered blocks.</figcaption> : null}
    </figure>
  );
}

type SeriesKey = "tx_per_block" | "paid_share" | "median_fee_usd";
const SERIES: { key: SeriesKey; label: string; fmt: (v: number) => string }[] = [
  { key: "tx_per_block", label: "Transactions per block", fmt: (v) => v.toFixed(1) },
  { key: "paid_share", label: "Paid share (estimate)", fmt: (v) => `${(v * 100).toFixed(2)}%` },
  { key: "median_fee_usd", label: "Median fee, USD", fmt: (v) => usd(v) },
];

// Main timeline (PROJECT.md 12.4): one point per UTC day with data, both windows, the subsidy end marked in lime.
export function Timeline({ data }: { data: SubsidyResponse }) {
  const start = Date.parse(data.before.start);
  const end = Date.parse(data.after.end);
  const cliff = Date.parse(`${data.cliff_date}T00:00:00Z`);
  const days = [...data.before.days, ...data.after.days];
  // Close to the card's drawn width at 1280 px, so 10 px text stays about 10 px (gate F58).
  const w = 330;
  const h = 120;
  const x = (t: number) => 30 + ((t - start) / Math.max(1, end - start)) * (w - 50);
  const dayMid = (d: string) => Date.parse(`${d}T12:00:00Z`);
  return (
    <div className="grid grid-cols-3 gap-4">
      {SERIES.map((s) => {
        const pts = days.map((d) => ({ d: d.date, v: d[s.key] })).filter((p): p is { d: string; v: number } => p.v !== null);
        const vals = pts.map((p) => p.v);
        const lo = Math.min(...vals);
        const hi = Math.max(...vals);
        const y = (v: number) => h - 22 - ((v - lo) / (hi - lo || 1)) * (h - 44);
        return (
          <figure key={s.key} className="rounded-[3px] border border-line bg-panel p-2.5">
            <figcaption className="mb-1 text-[11px] tracking-[0.08em] text-mute uppercase">{s.label}</figcaption>
            {pts.length ? (
              <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${s.label} per UTC day: ${pts.map((p) => `${formatDay(p.d)} ${s.fmt(p.v)}`).join(", ")}`}>
                <line x1={x(cliff)} x2={x(cliff)} y1={6} y2={h - 18} stroke="#c8f04a" strokeWidth={1.5} />
                <text x={x(cliff) + 4} y={14} className="fill-accent font-mono text-[10px]">
                  {formatDay(data.cliff_date)}
                </text>
                {pts.length > 1 ? <polyline points={pts.map((p) => `${x(dayMid(p.d)).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} fill="none" stroke="#e7e9ee" strokeWidth={1.2} /> : null}
                {pts.map((p) => (
                  <circle key={p.d} cx={x(dayMid(p.d))} cy={y(p.v)} r={2.5} fill="#e7e9ee">
                    <title>{`${formatDay(p.d)}: ${s.fmt(p.v)}`}</title>
                  </circle>
                ))}
                <text x={30} y={h - 4} className="fill-mute font-mono text-[10px]">
                  {formatDay(data.before.start.slice(0, 10))}
                </text>
                <text x={w - 20} y={h - 4} textAnchor="end" className="fill-mute font-mono text-[10px]">
                  {formatDay(new Date(end - 86_400_000).toISOString().slice(0, 10))}
                </text>
                <text x={w - 20} y={14} textAnchor="end" className="fill-mute font-mono text-[10px]">
                  {s.fmt(hi)}
                </text>
                <text x={w - 20} y={h - 20} textAnchor="end" className="fill-mute font-mono text-[10px]">
                  {s.fmt(lo)}
                </text>
              </svg>
            ) : (
              <p className="py-6 text-center text-[12px] text-mute">No ingested day in these windows.</p>
            )}
          </figure>
        );
      })}
    </div>
  );
}

export const estPerDay = (v: number | null) => (v === null ? NA : formatCountCompact(v));
