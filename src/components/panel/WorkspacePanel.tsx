"use client";

import type { InspectorResponse } from "../../lib/api-types.ts";
import { CITY_WINDOWS, formatMetric } from "../../lib/city.ts";
import { dataQuery, filterSummary, type ViewState } from "../../lib/view-state.ts";
import { usePolling } from "../hooks.ts";

const POLL_MS = 15_000;
const int = new Intl.NumberFormat("en-US");
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

const TREND_LABEL = { "5m": "per 5 minutes", "1h": "per hour", "1d": "per day" } as const;
const KIND_LABEL = { action: "Action type", token: "Pons token", hour: "One UTC hour" } as const;

function windowLine(d: InspectorResponse): string {
  const { start, end, basis } = d.window;
  if (!start || !end) return "No blocks ingested yet";
  if (d.kind === "hour") return `${utc(start)} to ${utc(end).slice(11)}`;
  const label = CITY_WINDOWS.find((w) => w.key === d.window.key)?.label ?? d.window.key;
  return basis === "txs" ? `${label}: ${utc(start)} to ${utc(end).slice(11)}` : `${label}: whole UTC days to ${utc(end)}`;
}

// Mini trend (PROJECT.md 11.1). Points sit at their time within the window; buckets without data are not drawn
// as zero because no ingested data is not the same as no transactions.
function Trend({ d }: { d: InspectorResponse }) {
  const pts = d.trend.points;
  const w = 356;
  const h = 48;
  const start = d.window.start ? Date.parse(d.window.start) : null;
  const end = d.window.end ? Date.parse(d.window.end) : null;
  if (!start || !end || pts.length === 0) return <p className="text-[12px] text-mute">No transactions in this window.</p>;
  const max = Math.max(...pts.map((p) => p.n), 1);
  const x = (ts: string) => ((Math.min(Math.max(Date.parse(ts), start), end) - start) / Math.max(end - start, 1)) * (w - 4) + 2;
  const y = (n: number) => h - 3 - (n / max) * (h - 6);
  const line = pts.map((p) => `${x(p.ts).toFixed(1)},${y(p.n).toFixed(1)}`).join(" ");
  return (
    <figure>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Transactions ${TREND_LABEL[d.trend.bucket]}, ${pts.length} points, peak ${int.format(max)}`}>
        <line x1={0} x2={w} y1={h - 3} y2={h - 3} stroke="#242a36" />
        {pts.length > 1 ? <polyline points={line} fill="none" stroke="#c8f04a" strokeWidth={1.5} /> : null}
        {pts.map((p) => (
          <circle key={p.ts} cx={x(p.ts)} cy={y(p.n)} r={1.8} fill="#c8f04a" />
        ))}
      </svg>
      <figcaption className="mt-1 font-mono text-[11px] text-mute">
        Transactions {TREND_LABEL[d.trend.bucket]}, {pts.length} bucket{pts.length === 1 ? "" : "s"} with data, peak {int.format(max)}
      </figcaption>
    </figure>
  );
}

function Kv({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-2.5 gap-y-[5px] text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-mute">{k}</dt>
          <dd className="text-right font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const H4 = ({ children }: { children: string }) => <h4 className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-mute">{children}</h4>;

function Details({ d, onClear }: { d: InspectorResponse; onClear: () => void }) {
  const v = d.values;
  const change = d.previous?.change;
  const changeText =
    d.previous === null ? "n/a for all to date" : change === null || change === undefined ? `— (previous window: ${int.format(d.previous.tx_count)})` : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  const age = d.token?.launch_ts ? Math.max(0, Date.now() - Date.parse(d.token.launch_ts)) : null;
  const ageText = age === null ? "—" : age < 86_400_000 ? `${Math.round(age / 3_600_000)} h` : `${Math.round(age / 86_400_000)} d`;

  return (
    <>
      <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">{d.label}</h3>
      <p className="text-[12px] text-mute">
        {KIND_LABEL[d.kind]} · {windowLine(d)}
      </p>
      {filterSummary(d.filters).length || d.filters.action ? (
        <p className="mt-1 text-[12px] text-mute">Filtered: {[d.filters.action ? `action ${d.filters.action}` : null, ...filterSummary(d.filters)].filter(Boolean).join(", ")}</p>
      ) : null}

      <H4>{d.kind === "hour" ? "Numbers in this hour" : "Numbers in this window"}</H4>
      <Kv
        rows={[
          [d.kind === "token" ? "Transactions moving it" : "Transactions", int.format(v.tx_count)],
          ["Wallets", v.wallets === null ? "24 h or less only" : int.format(v.wallets)],
          ["Gas volume", formatMetric(v.gas_volume, "gas_volume")],
          ["Avg fee (blended)", formatMetric(v.avg_fee_usd, "avg_fee_usd")],
          ["Paid share (estimate)", v.paid_share === null ? "—" : `${Math.round(v.paid_share * 100)}%`],
          ["Fail rate", d.kind === "token" ? "n/a for tokens" : formatMetric(v.fail_rate, "fail_rate")],
          [d.kind === "hour" ? "Change vs previous hour" : "Change vs previous window", changeText],
        ]}
      />

      {d.breakdown && d.breakdown.length ? (
        <>
          <H4>By action</H4>
          <Kv rows={d.breakdown.map((b) => [b.label, int.format(b.tx_count)] as [string, string])} />
        </>
      ) : null}

      <H4>Trend</H4>
      <Trend d={d} />

      {d.token ? (
        <>
          <H4>Token</H4>
          <Kv
            rows={[
              ["Name", d.token.name ?? "—"],
              ["Symbol", d.token.symbol ?? "—"],
              ["Launched", d.token.launch_ts ? `${utc(d.token.launch_ts)}, block ${int.format(d.token.launch_block ?? 0)}` : "—"],
              ["Age", ageText],
              ["Holders, top 10 share", "unavailable (Blockscout)"],
            ]}
          />
          {d.token.creator && d.token.creator_url ? (
            <p className="mt-1.5 text-[12px] text-mute">
              Creator{" "}
              <a className="font-mono text-text underline decoration-line underline-offset-2 hover:decoration-mute" href={d.token.creator_url} target="_blank" rel="noopener noreferrer">
                {shortHash(d.token.creator)}
              </a>
            </p>
          ) : null}
        </>
      ) : null}

      <H4>Newest transactions</H4>
      {d.samples.length === 0 ? (
        <p className="text-[12px] text-mute">None in this window.</p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.08em] text-mute">
              <th className="border-b border-line px-1.5 py-1.5 text-left font-medium">Hash</th>
              <th className="border-b border-line px-1.5 py-1.5 text-right font-medium">Fee</th>
              <th className="border-b border-line px-1.5 py-1.5 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {d.samples.map((s) => (
              <tr key={s.hash}>
                <td className="border-b border-line px-1.5 py-[7px] font-mono">
                  <a href={s.explorer_url} target="_blank" rel="noopener noreferrer" title={`Block ${int.format(s.block)}, ${utc(s.ts)}. Opens on Blockscout`} className="underline decoration-line underline-offset-2 hover:decoration-mute">
                    {shortHash(s.hash)}
                  </a>
                </td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{formatMetric(s.fee_usd, "avg_fee_usd")}</td>
                <td className={`border-b border-line px-1.5 py-[7px] text-right font-mono ${s.status === "failed" ? "text-c2" : ""}`}>{s.status === "failed" ? "failed" : "ok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <H4>Insights</H4>
      <p className="text-[12px] text-mute">Coming soon: insights that mention this {d.kind === "hour" ? "hour" : "object"} appear here once the insight rules run.</p>

      <div className="mt-4 flex gap-2">
        <button type="button" disabled title="Surveyor: coming soon" className="cursor-not-allowed rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] text-mute">
          Ask Surveyor about this · soon
        </button>
        <button type="button" onClick={onClear} className="rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute">
          Clear
        </button>
      </div>
    </>
  );
}

function InspectorPane({ state, onClear }: { state: ViewState; onClear: () => void }) {
  const selected = state.sel;
  const url = selected ? `/api/inspector?${dataQuery(state, { kind: selected.kind, key: selected.key })}` : null;
  const insp = usePolling<InspectorResponse>(url, state.at ? null : POLL_MS);

  if (!selected) {
    return (
      <>
        <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Inspector</h3>
        <div className="rounded-[3px] border border-dashed border-line p-[18px] text-center text-mute">
          Select a building, a terrain row, a heatmap cell or a label. Its numbers and the transactions behind them appear here.
        </div>
      </>
    );
  }
  // Details stay on screen while the window, filters or time change; another object's details are never shown.
  const d = insp.data && insp.data.kind === selected.kind && insp.data.key === selected.key ? insp.data : null;
  if (!d) {
    return <p className="text-mute" role="status">{insp.status === "error" ? "Details are unavailable. Retrying every 15 seconds." : "Loading details…"}</p>;
  }
  return (
    <>
      {insp.status === "error" ? (
        <p role="status" className="mb-2 text-[11px] text-c2">
          Refresh failed; showing the last details.
        </p>
      ) : insp.stale ? (
        <p role="status" className="mb-2 text-[11px] text-mute">
          Updating…
        </p>
      ) : null}
      <Details d={d} onClear={onClear} />
    </>
  );
}

const TABS = [
  { key: "inspector", label: "Inspector", ready: true },
  { key: "insights", label: "Insights", ready: false },
  { key: "surveyor", label: "Surveyor", ready: false },
  { key: "dispatch", label: "Dispatch", ready: false },
] as const;

export function WorkspacePanel({ state, onClear }: { state: ViewState; onClear: () => void }) {
  return (
    <aside className="grid min-h-0 grid-rows-[44px_1fr] border-l border-line bg-panel" aria-label="Workspace">
      <div className="flex border-b border-line" role="tablist" aria-label="Workspace panels">
        {TABS.map((t) => (
          <button
            key={t.key}
            id={`panel-tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={t.key === "inspector"}
            aria-controls={t.ready ? `panel-${t.key}` : undefined}
            aria-disabled={!t.ready || undefined}
            disabled={!t.ready}
            title={t.ready ? undefined : `${t.label}: coming soon`}
            className={`flex flex-1 flex-col items-center justify-center border-b-2 text-[12px] uppercase tracking-[0.06em] ${
              t.key === "inspector" ? "border-accent text-text" : "cursor-not-allowed border-transparent text-mute/60"
            }`}
          >
            {t.label}
            {t.ready ? null : <span className="text-[9px] leading-none tracking-[0.08em] text-mute">soon</span>}
          </button>
        ))}
      </div>
      <section id="panel-inspector" role="tabpanel" aria-labelledby="panel-tab-inspector" className="min-h-0 overflow-auto p-4">
        <InspectorPane state={state} onClear={onClear} />
      </section>
    </aside>
  );
}
