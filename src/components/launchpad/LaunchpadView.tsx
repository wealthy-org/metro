"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { LaunchpadResponse, LaunchpadToken } from "../../lib/api-types.ts";
import { formatAge, formatUsdCompact, NA, shortHex, utcMinute } from "../../lib/format.ts";
import { formatValue } from "../../lib/lenses.ts";
import { dataQuery, type ViewState } from "../../lib/view-state.ts";
import { usePolling } from "../hooks.ts";
import { POLL_MS, scopeNote, type Chip, type StageInfo } from "../stage.tsx";

// Launchpad lens (PROJECT.md 10.6; prototype renderLaunch). One row per Pons token, newest first; a click opens the
// token profile (PROJECT.md 10.6, gate F32). Holders and the top-10 share come from token_transfers (Phase 6 D1) and
// are marked partial when blocks since the launch are missing; the top ten leave out the token's curve pool, whose
// part is its own column (KL-25). USD volume is GeckoTerminal "now" (D2). A live view also lists the newest launches
// read over RPC that are not ingested yet (KL-24): their activity and holders are unknown, not zero.

type Col = "token" | "age" | "holders" | "top10" | "pool" | "swaps" | "tx" | "fee" | "volume";
const COLUMNS: { key: Col; label: string; title?: string }[] = [
  { key: "token", label: "Token" },
  { key: "age", label: "Age", title: "Time since the launch block: to now, or to the scrubber time when scrubbed" },
  { key: "holders", label: "Holders", title: "Addresses with a positive balance, from token transfers; change over 24 h" },
  { key: "top10", label: "Top 10 hold", title: "Share of supply held by the 10 largest holders, leaving out the token's Pons curve pool and the factory" },
  { key: "pool", label: "In pool", title: "Share of supply in the token's Pons curve pool (and the factory)" },
  { key: "swaps", label: "Swaps", title: "Swap transactions that moved the token in the window" },
  { key: "tx", label: "Tx", title: "Transactions that moved the token in the window" },
  { key: "fee", label: "Avg fee", title: "Average fee of those transactions, USD" },
  { key: "volume", label: "Volume 24h", title: "USD volume over its pools in the last 24 h, from GeckoTerminal, whatever the window" },
];

const int = new Intl.NumberFormat("en-US");
const NOT_INGESTED = "Launched after the newest ingested block: read from the factory logs over RPC, so its holders and transactions are not known yet";

function sortValue(t: LaunchpadToken, c: Col): number | string | null {
  switch (c) {
    case "token":
      return (t.symbol ?? t.address).toLowerCase();
    case "age":
      return -Date.parse(t.launch_ts);
    case "holders":
      return t.holders?.holders ?? null;
    case "top10":
      return t.holders?.top10_share ?? null;
    case "pool":
      return t.holders?.pool_share ?? null;
    case "swaps":
      return t.swaps;
    case "tx":
      return t.tx_count;
    case "fee":
      return t.avg_fee_usd;
    case "volume":
      return t.market?.volume_24h_usd ?? null;
  }
}

function Spark({ values }: { values: number[] }) {
  const w = 88;
  const h = 22;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - min) / (max - min || 1)) * (h - 2)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="ml-auto block">
      <polyline points={pts} fill="none" stroke="#c8f04a" strokeWidth="1.5" />
    </svg>
  );
}

const pct = (v: number | null | undefined, complete = true) => (v === null || v === undefined ? NA : `${(v * 100).toFixed(0)}%${complete ? "" : "*"}`);

export function LaunchpadView({ state, onInfo, notice }: { state: ViewState; onChange: (patch: Partial<ViewState>) => void; onInfo: (info: StageInfo) => void; notice: Chip | null }) {
  const router = useRouter();
  const lp = usePolling<LaunchpadResponse>(`/api/lens/launchpad/data?${dataQuery(state)}`, state.at ? null : POLL_MS);
  const d = lp.data;
  // Age ascending: newest launch first, as the note says.
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: "age", desc: false });
  const [search, setSearch] = useState("");
  const [minCol, setMinCol] = useState<Col>("holders");
  const [minVal, setMinVal] = useState("");

  useEffect(() => {
    if (d) onInfo({ coverage: d.coverage, subsidy_end: d.subsidy_end });
  }, [d, onInfo]);

  // Age is to now in the live view, as in the Inspector and the token profile; to the scrubber time when scrubbed.
  const endMs = state.at && d?.window.end ? Date.parse(d.window.end) : Date.now();
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = minVal.trim() === "" ? null : Number(minVal);
    const list = (d?.tokens ?? []).filter((t) => {
      if (q && !`${t.symbol ?? ""} ${t.name ?? ""} ${t.address}`.toLowerCase().includes(q)) return false;
      if (min !== null && Number.isFinite(min)) {
        const v = sortValue(t, minCol);
        // Shares are typed as percentages; the minimum applies to the figure shown in the column.
        const shown = typeof v === "number" ? (minCol === "top10" || minCol === "pool" ? v * 100 : v) : null;
        if (shown === null || shown < min) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      const x = sortValue(a, sort.col);
      const y = sortValue(b, sort.col);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : 1;
      return sort.desc ? -c : c;
    });
  }, [d, search, minCol, minVal, sort]);

  const selected = state.sel?.kind === "token" ? state.sel.key : null;
  const scope = d ? scopeNote(d) : null;
  const fastest = d?.tokens.find((t) => t.address === d.highlights.fastest);
  const label = (t: LaunchpadToken) => t.symbol || shortHex(t.address);
  const partial = d?.tokens.some((t) => t.holders && !t.holders.complete) ?? false;
  const fromRpc = d?.tokens.filter((t) => t.source === "rpc").length ?? 0;
  const known = d ? d.tokens.length - fromRpc : 0;
  const unpriced = d?.tokens.some((t) => !t.market_checked) ?? false;
  const open = (t: LaunchpadToken) => router.push(`/token/${t.address}`);

  return (
    <div className="min-h-0 overflow-auto px-[22px] py-[18px]">
      <h3 className="mb-1 font-display text-[22px] font-bold tracking-[0.01em]">Launchpad</h3>
      <p className="mt-2 mb-3.5 max-w-[92ch] text-[12px] text-mute">
        Pons tokens, newest first. &quot;Top 10 hold&quot; above 50% is highlighted as a measured fact about ownership, not a judgement about anyone; it leaves out the token&apos;s own curve pool, shown as &quot;In pool&quot;. Click a row to open the token.
        {scope ? <span className="ml-1 font-mono text-[11px]" title={scope.full}>{scope.short}</span> : null}
      </p>
      {notice ? (
        <p role="status" className="mb-3 text-[12px] text-mute">
          {notice.text}
        </p>
      ) : null}

      {d && d.tokens.length ? (
        <p className="mb-3 text-[12px] text-mute">
          {fastest ? (
            <>
              Most holder growth in 24 h: <b className="font-mono font-medium text-text">{label(fastest)}</b> (+{int.format((fastest.holders?.holders ?? 0) - (fastest.holders?.holders_24h_ago ?? 0))}).{" "}
            </>
          ) : null}
          {known
            ? d.highlights.concentrated.length
              ? `${d.highlights.concentrated.length} of ${known} ingested tokens have a top-10 share above 50%.`
              : "No ingested token has a top-10 share above 50%."
            : ""}
          {fromRpc ? ` ${fromRpc} newer launch${fromRpc === 1 ? " is" : "es are"} read from the chain and not ingested yet.` : ""}
          {d.recent && !d.recent.available ? " The newest launches could not be read from the chain; only ingested ones are listed." : ""}
          {d.market.available ? "" : " GeckoTerminal is unreachable, so volume is not shown."}
        </p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mute">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Symbol, name or address" aria-label="Filter tokens" className="w-[220px] rounded-[3px] border border-line bg-panel px-2 py-1 text-text" />
        <select aria-label="Minimum on column" value={minCol} onChange={(e) => setMinCol(e.target.value as Col)} className="rounded-[3px] border border-line bg-panel px-2 py-1 text-text">
          {COLUMNS.filter((c) => c.key !== "token" && c.key !== "age").map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          ≥
          <input value={minVal} onChange={(e) => setMinVal(e.target.value)} inputMode="decimal" placeholder="any" aria-label="Minimum value" className="w-20 rounded-[3px] border border-line bg-panel px-2 py-1 text-text" />
          {minCol === "top10" || minCol === "pool" ? "%" : minCol === "fee" || minCol === "volume" ? "USD" : ""}
        </label>
        {d ? <span className="font-mono text-[11px]">{rows.length} of {d.tokens.length}</span> : null}
      </div>

      {lp.status === "loading" && !d ? <p role="status" className="text-mute">Loading the launchpad…</p> : null}
      {lp.status === "error" && !d ? <p role="status" className="text-c2">Launchpad data is unavailable. Retrying every 15 seconds.</p> : null}
      {lp.status === "error" && d ? <p role="status" className="mb-2 text-[11px] text-c2">Refresh failed; showing the last data.</p> : null}
      {d && !d.window.start && !d.tokens.length ? <p className="text-mute">{state.at ? "No blocks were ingested before this point in time." : "No blocks ingested yet."}</p> : null}
      {d && d.window.start && !d.tokens.length ? <p className="text-mute">No Pons token was launched in the ingested blocks.</p> : null}

      {d && d.tokens.length ? (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort.col === c.key ? (sort.desc ? "descending" : "ascending") : "none"} className={`border-b border-line px-1.5 py-1.5 text-[10px] font-medium tracking-[0.08em] text-mute uppercase ${c.key === "token" ? "text-left" : "text-right"}`}>
                  <button type="button" title={c.title} onClick={() => setSort((s) => ({ col: c.key, desc: s.col === c.key ? !s.desc : c.key !== "token" && c.key !== "age" }))} className="uppercase hover:text-text">
                    {c.label}
                    {sort.col === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              ))}
              <th scope="col" className="border-b border-line px-1.5 py-1.5 text-right text-[10px] font-medium tracking-[0.08em] text-mute uppercase">
                7 days
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const h = t.holders;
              const change = h ? h.holders - h.holders_24h_ago : null;
              const sel = selected === t.address;
              const rpc = t.source === "rpc";
              const td = `border-b border-line px-1.5 py-[7px] text-right font-mono ${sel ? "bg-panel2" : "group-hover:bg-panel2"}`;
              const unknown = <span title={NOT_INGESTED} className="text-mute">{NA}</span>;
              return (
                <tr
                  key={t.address}
                  tabIndex={0}
                  aria-current={sel ? "true" : undefined}
                  aria-label={`${label(t)}: open the token profile`}
                  onClick={() => open(t)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open(t);
                    }
                  }}
                  className="group cursor-pointer"
                >
                  <td className={`border-b border-line px-1.5 py-[7px] text-left font-mono ${sel ? "bg-panel2" : "group-hover:bg-panel2"}`}>
                    <Link href={`/token/${t.address}`} prefetch={false} tabIndex={-1} onClick={(e) => e.stopPropagation()} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text" title={t.name ?? label(t)}>
                      {label(t)}
                    </Link>
                    {rpc ? (
                      <span title={NOT_INGESTED} className="ml-1.5 text-[10px] text-mute">
                        not ingested
                      </span>
                    ) : null}
                  </td>
                  <td className={td} title={`Launched in block ${int.format(t.launch_block)}, ${utcMinute(t.launch_ts)}`}>
                    {formatAge(t.launch_ts, endMs)}
                  </td>
                  <td className={td} title={h && !h.complete ? `Partial: from ${int.format(h.blocks_ingested ?? 0)} of ${int.format(h.blocks_expected ?? 0)} blocks since the launch` : undefined}>
                    {h ? (
                      <>
                        {int.format(h.holders)}
                        {h.complete ? "" : "*"}
                        {change ? <span className={change > 0 ? "ml-1 text-c0" : "ml-1 text-mute"}>{change > 0 ? `+${int.format(change)}` : int.format(change)}</span> : null}
                      </>
                    ) : rpc ? (
                      unknown
                    ) : (
                      NA
                    )}
                  </td>
                  <td className={`${td} ${t.concentrated ? "text-c1" : ""}`}>{rpc ? unknown : pct(h?.top10_share, h?.complete)}</td>
                  <td className={td}>{rpc ? unknown : pct(h?.pool_share, h?.complete)}</td>
                  <td className={td}>{t.swaps === null ? unknown : int.format(t.swaps)}</td>
                  <td className={td}>{t.tx_count === null ? unknown : int.format(t.tx_count)}</td>
                  <td className={td}>{rpc ? unknown : t.avg_fee_usd === null ? NA : formatValue(t.avg_fee_usd, "avg_fee_usd")}</td>
                  <td className={td} title={t.market_checked ? undefined : "Not looked up: GeckoTerminal is asked for 30 tokens per view"}>
                    {t.market?.volume_24h_usd !== null && t.market?.volume_24h_usd !== undefined ? formatUsdCompact(t.market.volume_24h_usd) : NA}
                  </td>
                  <td className={td}>{t.daily.length ? <Spark values={t.daily.map((x) => x.n)} /> : unknown}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {d && d.tokens.length ? (
        <p className="mt-3 text-[11px] text-mute">
          Holders and top-10 share are counted from the token transfers Metro has ingested since each launch; the top ten leave out the token&apos;s Pons curve pool and the factory, whose part is &quot;In pool&quot;.
          {partial ? " * partial: some blocks since the launch are not ingested yet, so these figures may be off." : ""}
          {fromRpc ? " \"not ingested\": launched after the newest ingested block, read from the factory logs; its figures are n/a, not zero." : ""} Volume 24h is from GeckoTerminal and is the current value, whatever the window
          {unpriced ? "; GeckoTerminal is asked for the first 30 tokens only" : ""}. 7 days: transactions per UTC day.
        </p>
      ) : null}
    </div>
  );
}
