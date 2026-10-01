"use client";

import { useEffect, useState } from "react";
import type { StatsResponse } from "../../lib/api-types.ts";
import { formatCountCompact, formatDay, formatGwei, formatUsdCompact, NA } from "../../lib/format.ts";
import { BrandMark } from "./BrandMark.tsx";

const POLL_MS = 5_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: StatsResponse }
  | { kind: "error"; data: StatsResponse | null };

const int = new Intl.NumberFormat("en-US");
const dash = NA;
const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

function windowTitle(label: string, n: number | undefined, start: string | null | undefined, end: string | undefined) {
  if (!start || !end || n === undefined) return label;
  return `${label}: n=${int.format(n)}, ${start.slice(11, 19)} to ${end.slice(11, 19)} UTC`;
}

function Readout({ label, value, unit, title, muted }: { label: string; value: string; unit?: string; title?: string; muted?: boolean }) {
  return (
    <div className="flex h-14 min-w-0 flex-col justify-center border-r border-line px-[16px]" title={title}>
      <small className="whitespace-nowrap text-[11px] uppercase tracking-[0.08em] text-mute">{label}</small>
      <b className={`whitespace-nowrap font-mono tabular-nums ${muted ? "text-[12px] font-normal text-mute" : "text-[15px] font-medium"}`}>
        {value}
        {unit ? <span className="ml-1 text-[11px] font-normal text-mute">{unit}</span> : null}
      </b>
    </div>
  );
}

// The live region only announces a change of status; the lag number updates every poll and stays outside it.
type Status = { tone: "mute" | "warn" | "error"; label: string; detail?: string; title?: string; dot?: boolean };

function statusOf(state: State): Status {
  if (state.kind === "loading") return { tone: "mute", label: "Connecting" };
  if (state.kind === "error") return { tone: "error", label: "Readout unavailable, retrying" };
  const d = state.data;
  if (d.live_block === null) return { tone: "mute", label: "No blocks ingested yet" };
  if (d.lag_blocks === null) return { tone: "warn", label: "Chain head unknown" };
  if (d.delayed) {
    return {
      tone: "warn",
      label: "Data delayed",
      detail: `, ${int.format(d.lag_blocks)} blocks`,
      title: `The Collector is ${int.format(d.lag_blocks)} blocks behind the chain head`,
    };
  }
  return { tone: "mute", label: "Collector in sync", dot: true };
}

const TONE = { mute: "border-line text-mute", warn: "border-c1 text-c1", error: "border-c2 text-c2" } as const;

function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={`whitespace-nowrap rounded-[3px] border px-[9px] py-[5px] font-mono text-[11px] uppercase tracking-[0.06em] ${TONE[status.tone]}`}
      title={status.title}
    >
      {status.dot ? <i aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-c0" /> : null}
      <span role="status" aria-live="polite">
        {status.label}
      </span>
      {status.detail ? <span aria-hidden>{status.detail}</span> : null}
    </span>
  );
}

// Blockscout chain stats (PROJECT.md 8.1) as one readout, so the Ticker keeps its width at 1280 px in both states.
// While the explorer is unreachable (KL-3) it says so.
function ChainStatsReadout({ d }: { d: StatsResponse | null }) {
  const s = d?.chain_stats;
  if (!s) return <Readout label="Chain stats" value={dash} />;
  if (!s.available) {
    return <Readout label="Chain stats" value="unavailable" muted title={`${s.reason}. Source: Blockscout, checked ${utc(s.checked_at)}`} />;
  }
  const tx = s.total_transactions != null ? formatCountCompact(s.total_transactions) : dash;
  const addresses = s.total_addresses != null ? formatCountCompact(s.total_addresses) : dash;
  const day = s.transactions_24h != null ? `, ${int.format(s.transactions_24h)} tx in the last 24 h` : "";
  return <Readout label="Tx / addresses" value={`${tx} / ${addresses}`} title={`Total transactions and addresses${day}. Blockscout stats service, ${utc(s.fetched_at)}`} />;
}

export function Ticker() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let controller: AbortController | null = null;
    let last: StatsResponse | null = null;

    async function poll() {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch("/api/v1/stats", { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        last = (await res.json()) as StatsResponse;
        setState({ kind: "ready", data: last });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ kind: "error", data: last });
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, []);

  const d = state.kind === "loading" ? null : state.data;
  const econ = d?.chain ?? null;
  const econTitle = econ ? `DefiLlama, fetched ${utc(econ.fetched_at)}` : "DefiLlama figures are not available yet";
  const feeDay = econ?.fees_day ? formatDay(econ.fees_day) : undefined;

  return (
    <header className="flex h-14 items-center border-b border-line bg-panel pr-4" aria-label="Chain readout" aria-busy={state.kind === "loading"}>
      <div className="flex h-14 w-16 flex-none items-center justify-center border-r border-line font-display text-[26px] font-extrabold tracking-[0.02em] text-accent" aria-label="Metro">
        <BrandMark mark />
      </div>
      <Readout label="Gas price" value={d?.gas_price_gwei != null ? formatGwei(d.gas_price_gwei) : dash} unit={d?.gas_price_gwei != null ? "Gwei" : undefined} title="eth_gasPrice, refreshed every minute" />
      <Readout label="Base fee" value={d?.base_fee_gwei != null ? formatGwei(d.base_fee_gwei) : dash} unit={d?.base_fee_gwei != null ? "Gwei" : undefined} title="Base fee of the newest ingested block" />
      <Readout label="TPS" value={d?.tps_current != null ? d.tps_current.toFixed(1) : dash} title={windowTitle("Transactions per second over the last minute of ingested blocks", d?.tps?.n, d?.tps?.window.start, d?.tps?.window.end)} />
      <Readout label="Block" value={d?.live_block != null ? `#${int.format(d.live_block)}` : dash} title={d?.block_ts ? `Newest ingested block, ${utc(d.block_ts)}` : undefined} />
      <Readout label="TVL" value={econ?.tvl_usd != null ? formatUsdCompact(econ.tvl_usd) : dash} title={econTitle} />
      <Readout label="Chain fees" value={econ?.fees_usd != null ? formatUsdCompact(econ.fees_usd) : dash} unit={econ?.fees_usd != null ? feeDay : undefined} title={`Gas fees paid by users on the chain, one UTC day. ${econTitle}`} />
      <Readout label="Revenue" value={econ?.revenue_usd != null ? formatUsdCompact(econ.revenue_usd) : dash} unit={econ?.revenue_usd != null ? feeDay : undefined} title={`Chain fees net of L1 costs and the Arbitrum fee share, one UTC day. ${econTitle}`} />
      <ChainStatsReadout d={d} />
      <div className="flex-1" />
      <StatusPill status={statusOf(state)} />
    </header>
  );
}
