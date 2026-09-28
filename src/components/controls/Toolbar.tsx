"use client";

import type { ReactNode } from "react";
import { CITY_ACTIONS, CITY_WINDOWS, isCityAction, type CityWindow } from "../../lib/city.ts";
import { metricIssue, type LensKey, type Metric, type ViewState } from "../../lib/view-state.ts";
import { FilterMenu } from "./FilterMenu.tsx";

// Stage toolbar (prototype lines 79 to 85 and 204 to 221): Metric, Window and Action, plus the filters that are
// not in the prototype (PROJECT.md 11.2) behind one button. At 1280 px the stage is 828 px wide, so only "Metric"
// keeps a visible label; the selects carry theirs in aria-label and in their first option.

// Short labels for the toolbar; full names live in tooltips, legends and the Inspector.
type MetricButton = { key: Metric; label: string; title: string };
const PER_OBJECT: MetricButton[] = [
  { key: "tx_count", label: "Transactions", title: "Transactions in the window" },
  { key: "gas_volume", label: "Gas", title: "Gas volume: total gas used" },
  { key: "avg_fee_usd", label: "Avg fee", title: "Average fee per transaction, USD" },
  { key: "wallets", label: "Wallets", title: "Unique sending wallets" },
  { key: "fail_rate", label: "Fail rate", title: "Share of failed transactions" },
];
const METRIC_BUTTONS: Record<LensKey, MetricButton[]> = {
  city: PER_OBJECT,
  terrain: PER_OBJECT,
  heatmap: [
    { key: "tx_count", label: "Transactions", title: "Transactions per hour" },
    { key: "gas_volume", label: "Gas", title: "Gas volume per hour" },
    { key: "avg_fee_usd", label: "Avg fee", title: "Average fee per transaction, USD" },
    { key: "gas_price", label: "Gas price", title: "Average block base fee, Gwei, chain-wide" },
  ],
  // Flow colors by fee and Launchpad sorts by column; neither has a Metric choice.
  flow: [],
  launchpad: [],
};

const segButton = (on: boolean, off: boolean) =>
  `whitespace-nowrap border-r border-line px-[11px] py-1.5 text-[12px] normal-case tracking-normal last:border-r-0 ${
    on ? "bg-panel2 text-accent" : off ? "cursor-not-allowed text-mute/50" : "text-mute hover:text-text"
  }`;

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { key: T; label: string; disabled?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-[3px] border border-line" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} disabled={Boolean(o.disabled)} title={o.disabled} onClick={() => onChange(o.key)} className={segButton(value === o.key, Boolean(o.disabled))}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const selectClass = "rounded-[3px] border border-line bg-panel2 px-2 py-[5px] text-[12px] text-text";

export function Toolbar({ lens, state, onChange, extra }: { lens: LensKey; state: ViewState; onChange: (patch: Partial<ViewState>) => void; extra?: ReactNode }) {
  const metrics = METRIC_BUTTONS[lens];
  return (
    <div className="flex h-11 min-w-0 items-center gap-3 border-b border-line bg-panel px-3.5">
      {metrics.length ? (
      <div className="flex flex-none items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-mute">
        <span id="metric-label">Metric</span>
        <div className="flex overflow-hidden rounded-[3px] border border-line" role="group" aria-labelledby="metric-label">
          {metrics.map((m) => {
            const issue = metricIssue(lens, m.key, state.window);
            return (
              <button
                key={m.key}
                type="button"
                aria-pressed={state.metric === m.key}
                disabled={issue !== null}
                title={issue ?? m.title}
                onClick={() => onChange({ metric: m.key })}
                className={segButton(state.metric === m.key, issue !== null)}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
      ) : null}
      {/* The live Flow has no time window; the window still decides whether raw-only filters apply (KL-20). */}
      {lens !== "flow" ? (
        <select aria-label="Window" value={state.window} onChange={(e) => onChange({ window: e.target.value as CityWindow })} className={`flex-none ${selectClass}`}>
          {CITY_WINDOWS.map((w) => (
            <option key={w.key} value={w.key}>
              {w.label}
            </option>
          ))}
        </select>
      ) : null}
      <select
        aria-label="Action"
        value={state.filters.action ?? ""}
        onChange={(e) => onChange({ filters: { ...state.filters, action: isCityAction(e.target.value) ? e.target.value : null } })}
        className={`flex-none ${selectClass}`}
      >
        <option value="">All actions</option>
        {CITY_ACTIONS.map((a) => (
          <option key={a.key} value={a.key}>
            {a.label}
          </option>
        ))}
      </select>
      <FilterMenu state={state} onChange={onChange} />
      {extra}
    </div>
  );
}
