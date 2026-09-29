"use client";

import Link from "next/link";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { InsightsResponse, InsightT, InspectorResponse } from "../../lib/api-types.ts";
import { TOPICS } from "../../analyst/topics.ts";
import { CITY_WINDOWS, actionLabel, formatMetric } from "../../lib/city.ts";
import { formatAge, NA, shortHex as shortHash, utcMinute as utc } from "../../lib/format.ts";
import { clusterLabel } from "../../lib/graph.ts";
import { relatedTo } from "../../lib/insight-match.ts";
import { dataQuery, filterSummary, type ViewState } from "../../lib/view-state.ts";
import { usePolling } from "../hooks.ts";
import { DispatchPane } from "../dispatch/DispatchPane.tsx";
import { SurveyorPane, type AskSeed } from "../surveyor/SurveyorPane.tsx";
import { InsightCard } from "../insights/InsightCard.tsx";

const POLL_MS = 15_000;
const int = new Intl.NumberFormat("en-US");

const TREND_LABEL = { "5m": "per 5 minutes", "1h": "per hour", "1d": "per day" } as const;
const KIND_LABEL = { action: "Action type", token: "Pons token", hour: "One UTC hour", address: "Address" } as const;

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

function Details({ d, onClear, related, onAsk }: { d: InspectorResponse; onClear: () => void; related: InsightT[] | null; onAsk: (seed: AskSeed) => void }) {
  const v = d.values;
  const change = d.previous?.change;
  const changeText =
    d.previous === null ? "n/a for all to date" : change === null || change === undefined ? `${NA} (previous window: ${int.format(d.previous.tx_count)})` : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  const ageText = d.token?.launch_ts ? formatAge(d.token.launch_ts, Date.now()) : NA;

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
          [d.kind === "token" ? "Transactions moving it" : d.kind === "address" ? "Transactions involving it" : "Transactions", int.format(v.tx_count)],
          ...(d.kind === "address" ? [] : [["Wallets", v.wallets === null ? "24 h or less only" : int.format(v.wallets)] as [string, string]]),
          [d.kind === "address" ? "Gas used (sent)" : "Gas volume", formatMetric(v.gas_volume, "gas_volume")],
          [d.kind === "address" ? "Avg fee paid" : "Avg fee (blended)", formatMetric(v.avg_fee_usd, "avg_fee_usd")],
          ["Median fee", v.median_fee_usd === null ? (v.tx_count && d.kind !== "address" ? "24 h or less only" : NA) : formatMetric(v.median_fee_usd, "avg_fee_usd")],
          ["Paid share (estimate)", v.paid_share === null ? NA : `${Math.round(v.paid_share * 100)}%`],
          ["Fail rate", d.kind === "token" ? "n/a for tokens" : formatMetric(v.fail_rate, "fail_rate")],
          [d.kind === "hour" ? "Change vs previous hour" : "Change vs previous window", changeText],
        ]}
      />

      {d.address ? (
        <>
          <H4>Address</H4>
          <Kv
            rows={[
              ["Kind", d.address.kind === "contract" ? `Contract${d.address.label ? `, ${d.address.label}` : ""}` : "Address (no contract code)"],
              ["Sent / received (transactions)", `${int.format(d.address.sent)} / ${int.format(d.address.received)}`],
              ["ETH transfers in / out", `${int.format(d.address.native_transfers.in)} / ${int.format(d.address.native_transfers.out)}`],
              ["Token transfers in / out", `${int.format(d.address.token_transfers.in)} / ${int.format(d.address.token_transfers.out)}`],
              ["Fees paid", formatMetric(d.address.fee_paid_usd, "avg_fee_usd")],
              ["Group", d.address.group ? clusterLabel(d.address.group) : "None in this window"],
            ]}
          />
          <p className="mt-1.5 text-[12px] text-mute">
            Groups are wallets that received ETH from the same address in this window; no identity is implied. More on the{" "}
            <Link className="text-text underline decoration-mute hover:decoration-text" href={`/wallet/${d.key}`} prefetch={false}>
              wallet profile
            </Link>
            .
          </p>
        </>
      ) : null}

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
              ["Name", d.token.name ?? NA],
              ["Symbol", d.token.symbol ?? NA],
              ["Launched", d.token.launch_ts ? `${utc(d.token.launch_ts)}, block ${int.format(d.token.launch_block ?? 0)}` : NA],
              ["Age", ageText],
            ]}
          />
          <p className="mt-1.5 text-[12px] text-mute">
            {d.token.creator ? (
              <>
                Creator{" "}
                <Link className="font-mono text-text underline decoration-mute hover:decoration-text" href={`/wallet/${d.token.creator}`} prefetch={false}>
                  {shortHash(d.token.creator)}
                </Link>
                .{" "}
              </>
            ) : null}
            Holders, top-10 share and volume are on the{" "}
            <Link className="text-text underline decoration-mute hover:decoration-text" href={`/token/${d.key}`} prefetch={false}>
              token profile
            </Link>
            .
          </p>
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
                  <Link href={`/tx/${s.hash}`} prefetch={false} title={`Block ${int.format(s.block)}, ${utc(s.ts)}`} className="underline decoration-mute hover:decoration-text">
                    {shortHash(s.hash)}
                  </Link>
                </td>
                <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{formatMetric(s.fee_usd, "avg_fee_usd")}</td>
                <td className={`border-b border-line px-1.5 py-[7px] text-right font-mono ${s.status === "failed" ? "text-c2" : ""}`}>{s.status === "failed" ? "failed" : "ok"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <H4>Insights</H4>
      {related === null ? (
        <p className="text-[12px] text-mute">Loading insights…</p>
      ) : related.length ? (
        related.map((i) => <InsightCard key={i.id} insight={i} compact />)
      ) : (
        <p className="text-[12px] text-mute">No active finding mentions this {d.kind === "hour" ? "hour" : d.kind === "token" ? "token" : d.kind === "address" ? "address" : "action type"}.</p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() =>
            onAsk(
              d.kind === "token"
                ? { question: TOPICS.token.question, scope: { token: d.key } }
                : d.kind === "address"
                  ? { question: TOPICS.wallet.question, scope: { address: d.key } }
                  : d.kind === "hour"
                    ? { question: TOPICS.hours.question }
                    : { question: `When is ${actionLabel(d.key)} cheapest?`, scope: { action: d.key } },
            )
          }
          className="rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute"
        >
          Ask Surveyor about this
        </button>
        <button type="button" onClick={onClear} className="rounded-[3px] border border-line bg-panel2 px-[11px] py-[7px] text-[12px] hover:border-mute">
          Clear
        </button>
      </div>
    </>
  );
}

function InspectorPane({ state, note, onClear, insights, onAsk }: { state: ViewState; note: string | null; onClear: () => void; insights: InsightT[] | null; onAsk: (seed: AskSeed) => void }) {
  const selected = state.sel;
  const url = selected && !note ? `/api/inspector?${dataQuery(state, { kind: selected.kind, key: selected.key })}` : null;
  const insp = usePolling<InspectorResponse>(url, state.at ? null : POLL_MS);

  if (selected && note) {
    return (
      <>
        <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Inspector</h3>
        <p role="status" className="rounded-[3px] border border-dashed border-line p-[18px] text-mute">
          {note}
        </p>
      </>
    );
  }
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
      <Details d={d} onClear={onClear} onAsk={onAsk} related={insights === null ? null : relatedTo(insights.filter((i) => i.status === "finding"), { kind: d.kind === "address" ? "wallet" : d.kind, key: d.key })} />
    </>
  );
}

// Insights tab (PROJECT.md 7, 13.2): findings first, then "not enough data" rows, each with n, window and evidence.
function InsightsPane({ data, status }: { data: InsightsResponse | null; status: "loading" | "ok" | "error" }) {
  const findings = data?.insights.filter((i) => i.status === "finding") ?? [];
  const low = data?.insights.filter((i) => i.status === "not_enough_data") ?? [];
  return (
    <>
      <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Insights</h3>
      <p className="mb-3 text-[12px] text-mute">
        Rule-based findings from the Ledger of Facts. Each states its sample and window; under {data?.min_sample ?? 30} samples a rule shows &quot;not enough data&quot;.{" "}
        <a href="/methodology" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
          How they are computed
        </a>
      </p>
      {status === "loading" && !data ? <p role="status" className="text-mute">Loading insights…</p> : null}
      {status === "error" && !data ? <p role="status" className="text-c2">Insights are unavailable. Retrying every minute.</p> : null}
      {data && !data.insights.length ? <p className="text-mute">No insight has been computed yet. The rules run with the Collector and once a day.</p> : null}
      {findings.map((i) => (
        <InsightCard key={i.id} insight={i} />
      ))}
      {low.length ? <H4>Not enough data yet</H4> : null}
      {low.map((i) => (
        <InsightCard key={i.id} insight={i} compact />
      ))}
      {data?.insights.length ? (
        <p className="mt-2 text-[11px] text-mute">
          Computed {data.computed_at ? utc(data.computed_at) : NA}.{" "}
          <a href="/insights" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
            All insights
          </a>
        </p>
      ) : null}
    </>
  );
}

const TABS = [
  { key: "inspector", label: "Inspector", ready: true },
  { key: "insights", label: "Insights", ready: true },
  { key: "surveyor", label: "Surveyor", ready: true },
  { key: "dispatch", label: "Dispatch", ready: true },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const INSIGHTS_POLL_MS = 60_000;

export function WorkspacePanel({ state, note = null, onClear }: { state: ViewState; note?: string | null; onClear: () => void }) {
  const [tab, setTab] = useState<TabKey>("inspector");
  const [askSeed, setAskSeed] = useState<AskSeed>(null);
  const ins = usePolling<InsightsResponse>("/api/v1/insights", INSIGHTS_POLL_MS);
  // Selecting an object shows it, whichever tab was open (prototype select(): showTab('insp')).
  const selKey = state.sel ? `${state.sel.kind}:${state.sel.key}` : null;
  useEffect(() => {
    if (selKey) setTab("inspector");
  }, [selKey]);
  const ready = TABS.filter((t) => t.ready).map((t) => t.key as TabKey);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = ready.indexOf(tab);
    const next = ready[(i + (e.key === "ArrowRight" ? 1 : ready.length - 1)) % ready.length] ?? "inspector";
    setTab(next);
    document.getElementById(`panel-tab-${next}`)?.focus();
  };
  return (
    <aside className="grid min-h-0 grid-rows-[44px_1fr] border-l border-line bg-panel" aria-label="Workspace">
      <div className="flex border-b border-line" role="tablist" aria-label="Workspace panels" onKeyDown={onKey}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              id={`panel-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={t.ready ? `panel-${t.key}` : undefined}
              aria-disabled={!t.ready || undefined}
              disabled={!t.ready}
              tabIndex={on ? 0 : -1}
              onClick={() => t.ready && setTab(t.key)}
              title={t.ready ? undefined : `${t.label}: coming soon`}
              className={`flex flex-1 flex-col items-center justify-center border-b-2 text-[12px] uppercase tracking-[0.06em] ${
                on ? "border-accent text-text" : t.ready ? "border-transparent text-mute hover:text-text" : "cursor-not-allowed border-transparent text-mute/60"
              }`}
            >
              {t.label}
              {t.ready ? null : <span className="text-[9px] leading-none tracking-[0.08em] text-mute">soon</span>}
            </button>
          );
        })}
      </div>
      {tab === "inspector" ? (
        <section id="panel-inspector" role="tabpanel" aria-labelledby="panel-tab-inspector" className="min-h-0 overflow-auto p-4">
          <InspectorPane
            state={state}
            note={note}
            onClear={onClear}
            insights={ins.data?.insights ?? (ins.status === "error" ? [] : null)}
            onAsk={(seed) => {
              setAskSeed(seed);
              setTab("surveyor");
            }}
          />
        </section>
      ) : tab === "surveyor" ? (
        <section id="panel-surveyor" role="tabpanel" aria-labelledby="panel-tab-surveyor" className="min-h-0 overflow-auto p-4">
          <SurveyorPane state={state} seed={askSeed} />
        </section>
      ) : tab === "dispatch" ? (
        <section id="panel-dispatch" role="tabpanel" aria-labelledby="panel-tab-dispatch" className="min-h-0 overflow-auto p-4">
          <DispatchPane />
        </section>
      ) : (
        <section id="panel-insights" role="tabpanel" aria-labelledby="panel-tab-insights" className="min-h-0 overflow-auto p-4">
          <InsightsPane data={ins.data} status={ins.status === "error" ? "error" : ins.data ? "ok" : "loading"} />
        </section>
      )}
    </aside>
  );
}
