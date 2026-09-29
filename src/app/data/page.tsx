import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { ProfileShell, Section } from "../../components/profile/Profile.tsx";
import { blocksPerDay } from "../../engine/subsidy.ts";
import { crossCheck } from "../../server/cross-check.ts";
import { EXPORT_DATASETS } from "../../server/export-datasets.ts";
import { getDb } from "../../server/http.ts";
import { getHealth } from "../../server/health.ts";
import { num, rows } from "../../server/query.ts";
import { NA, utcMinute as utc } from "../../lib/format.ts";

// /data (PROJECT.md 7, 9.2; Phase 12, AT 3): the dataset catalog, ingested coverage per UTC day, the Collector and
// backfill status from the same builder as /api/health, the retention policy as it stands, and the CSV exports.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Data, Metro" };

const int = new Intl.NumberFormat("en-US");
const DAY = 86_400_000;

type CatalogRow = { table: string; columns: string; filled: string };

// The tables of PROJECT.md 17 with what fills them; columns stay in the order of schema.md.
const CATALOG: CatalogRow[] = [
  { table: "blocks", columns: "number, hash, ts, gas_used, gas_limit, base_fee, tx_count", filled: "Live ingest and the backfill" },
  { table: "txs", columns: "hash, block, ts, from, to, value, gas_used, gas_price, fee_eth, fee_usd, status, method, action, subsidy_class", filled: "Live ingest and the backfill; daily partitions" },
  { table: "token_transfers", columns: "tx_hash, log_index, token, from, to, amount, ts", filled: "Live ingest and the backfill, from ERC-20 Transfer logs" },
  { table: "tokens", columns: "address, symbol, name, decimals, is_pons, created_at, holders, supply", filled: "Pons factory events and metadata reads" },
  { table: "pons_launches", columns: "token, creator, block, ts, params", filled: "Live ingest and the backfill, from TokenLaunched logs" },
  { table: "known_contracts", columns: "address, kind, label", filled: "Mirrored from config when the Collector starts" },
  { table: "agg_minute", columns: "ts, action, tx_count, gas_used, fee_usd_sum, fee_usd_median, wallets", filled: "Rollup of txs every flush" },
  { table: "agg_day", columns: "date, action, subsidy_class, tx_count, gas_used, fee_usd_avg, fee_usd_median, active_wallets, failed_tx_count, system_tx_count", filled: "Rollup per UTC day" },
  { table: "prices", columns: "ts, eth_usd", filled: "Stored minute ETH prices" },
  { table: "facts", columns: "id, key, window_start, window_end, value, n, computed_at", filled: "The fact engine, every 10 minutes with the Collector and once a day by cron" },
  { table: "insights", columns: "id, rule, status, text, n, severity, window_start, window_end, evidence_url, created_at, expires_at", filled: "The insight rules over the facts" },
  { table: "dispatch", columns: "id, kind, range_label, body_md, facts_ref, model_used, created_at", filled: "The daily cron and the custom report builder" },
  { table: "analyst_answers", columns: "id, question_hash, facts_ref, answer, model_used, validated, created_at", filled: "Surveyor answers, cached for 7 days" },
  { table: "ingest_cursor", columns: "name, block, range_start, range_end, blocks_per_second, updated_at, last_error", filled: "The Collector's live and backfill cursors" },
  { table: "users", columns: "id, daily_ask_count, last_ask_date", filled: "Surveyor per-browser and per-network counters; no raw IP is stored" },
];

function etaText(seconds: number | null): string {
  if (seconds === null) return NA;
  if (seconds < 3_600) return `${int.format(Math.round(seconds / 60))} min`;
  return `${(seconds / 3_600).toFixed(1)} h`;
}

export default async function DataPage() {
  const db = getDb();
  const [health, perDay, daily, xcheck] = await Promise.all([
    getHealth().catch(() => null),
    blocksPerDay(db).catch(() => null),
    rows(db, sql`
      SELECT to_char(date_trunc('day', b.ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             count(*) AS blocks, coalesce(sum(b.tx_count), 0) AS txs
      FROM blocks b WHERE b.ts >= now() - interval '30 days' GROUP BY 1 ORDER BY 1 DESC`),
    crossCheck(db, { days: 7 }).catch(() => null),
  ]);
  const c = health?.collector ?? null;
  const cov = daily.map((d) => {
    const blocks = num(d.blocks);
    return { day: String(d.day), blocks, txs: num(d.txs), share: perDay ? blocks / perDay : null };
  });

  const kv = "grid grid-cols-[auto_1fr] gap-x-4 gap-y-[5px] text-[12px] [&_dt]:text-mute [&_dd]:font-mono [&_dd]:text-right";
  const table = "w-full border-collapse text-[12px]";
  const th = "border-b border-line px-1.5 py-1.5 text-left font-medium text-[10px] tracking-[0.08em] text-mute uppercase";
  const td = "border-b border-line px-1.5 py-[7px] align-top";

  return (
    <ProfileShell kind="Data">
      <h1 className="font-display text-[34px] leading-none font-bold">Data</h1>
      <p className="mt-2 max-w-[92ch] text-[13px] text-mute">
        Every view in Metro rests on these tables. The Collector reads Robinhood Chain in bounded runs, so the ingested blocks are a sample of each day and every view states its window; the tables below are public, read-only and exportable as CSV with the same bounds the API enforces.
      </p>

      <Section title="Collector" note="The same telemetry as /api/health; live means the gap to the chain head is under the alert threshold.">
        {health === null ? (
          <p role="status" className="text-[12px] text-c2">
            The database is unreachable right now, so the Collector status cannot be read.
          </p>
        ) : (
          <div className="max-w-[640px]">
            <dl className={kv}>
              <dt>Status</dt>
              <dd>
                {health.status}
                {c?.delayed && health.status !== "delayed" ? " (delayed)" : ""}
              </dd>
              <dt>Live block / chain head</dt>
              <dd>
                {c?.live_block === null || c?.live_block === undefined ? NA : int.format(c.live_block)} / {c?.head_block === null || c?.head_block === undefined ? NA : int.format(c.head_block)}
              </dd>
              <dt>Lag</dt>
              <dd>{c?.lag_blocks === null || c?.lag_blocks === undefined ? NA : `${int.format(c.lag_blocks)} blocks (alert at ${int.format(c.lag_alert_blocks)})`}</dd>
              <dt>Last ingest</dt>
              <dd>{c?.updated_at ? utc(new Date(c.updated_at).toISOString()) : NA}</dd>
              <dt>Backfill progress</dt>
              <dd>{c?.backfill_progress_percent === null || c?.backfill_progress_percent === undefined ? NA : `${c.backfill_progress_percent.toFixed(4)}%`}</dd>
              <dt>Backfill at block</dt>
              <dd>{c?.backfill_current_block === null || c?.backfill_current_block === undefined ? NA : `${int.format(c.backfill_current_block)} of ${c.backfill_range ? `${int.format(c.backfill_range.start)} to ${int.format(c.backfill_range.end)}` : NA}`}</dd>
              <dt>Remaining / rate / estimate</dt>
              <dd>
                {c?.backfill_blocks_remaining === null || c?.backfill_blocks_remaining === undefined ? NA : int.format(c.backfill_blocks_remaining)} blocks /{" "}
                {c?.backfill_blocks_per_second ? `${c.backfill_blocks_per_second.toFixed(1)} blocks/s` : NA} / {etaText(c?.estimated_time_remaining_seconds ?? null)}
              </dd>
              <dt>Last error</dt>
              <dd className="max-w-[380px] truncate" title={c?.last_error ?? undefined}>
                {c?.last_error ?? "none"}
                {c?.last_error_at ? ` (${utc(new Date(c.last_error_at).toISOString())})` : ""}
              </dd>
            </dl>
            <p className="mt-2 text-[11px] text-mute">
              The backfill walks backward from the first live block within a storage budget on the Neon free branch (KL-1), so it may stop before the range start until the storage decision; the progress is exact for the blocks it has written.
            </p>
          </div>
        )}
      </Section>

      <Section title="Coverage by UTC day" note="Last 30 days with ingested blocks. Expected blocks come from the chain's own rate (about 10 a second); every figure in Metro rests on the ingested blocks only.">
        {cov.length === 0 ? (
          <p className="text-[12px] text-mute">No block is ingested yet.</p>
        ) : (
          <table className={`${table} max-w-[720px]`}>
            <thead>
              <tr>
                {["Day", "Blocks ingested", "Share of the day", "Transactions ingested"].map((h, i) => (
                  <th key={h} scope="col" className={`${th} ${i > 0 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cov.map((r) => (
                <tr key={r.day}>
                  <td className={`${td} font-mono`}>{r.day}</td>
                  <td className={`${td} text-right font-mono`}>{int.format(r.blocks)}</td>
                  <td className={`${td} text-right font-mono`}>{r.share === null ? NA : `${(r.share * 100).toFixed(3)}%`}</td>
                  <td className={`${td} text-right font-mono`}>{int.format(r.txs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 max-w-[92ch] text-[11px] text-mute">
          Days brought in by the sampled backfill (KL-28) read about 12 slices of 30 blocks each, so their share is far under 1%; rates and shares computed per block stay representative, totals are estimates and every view says so.
        </p>
      </Section>

      <Section title="Accuracy cross-check" note="Estimated day totals against a uniform random sample over RPC and growthepie's per-day count (PROJECT.md 19, AT 6; KL-37).">
        {xcheck === null ? (
          <p className="text-[12px] text-mute">The cross-check could not be read right now.</p>
        ) : (
          <>
            <table className={`${table} max-w-[900px]`}>
              <thead>
                <tr>
                  {["Day", "Stored estimate", "±95%", "growthepie", "Stored vs growthepie", "ArbOS share"].map((h, i) => (
                    <th key={h} scope="col" className={`${th} ${i > 0 ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {xcheck.days.map((d) => (
                  <tr key={d.day}>
                    <td className={`${td} font-mono`}>{d.day}</td>
                    <td className={`${td} text-right font-mono`}>{int.format(d.stored.estimate)}</td>
                    <td className={`${td} text-right font-mono text-mute`}>±{int.format(d.stored.ci95)}</td>
                    <td className={`${td} text-right font-mono`}>{d.growthepie === null ? NA : int.format(d.growthepie)}</td>
                    <td className={`${td} text-right font-mono`}>{d.storedVsGtpPct === null ? NA : `${d.storedVsGtpPct >= 0 ? "+" : ""}${(d.storedVsGtpPct * 100).toFixed(1)}%`}</td>
                    <td className={`${td} text-right font-mono`}>{d.arbosShare === null ? NA : `${(d.arbosShare * 100).toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 max-w-[92ch] text-[11px] text-mute">
              The reference is an independent uniform random sample of single blocks over RPC (<code className="font-mono">eth_getBlockTransactionCountByNumber</code>, n = 1,000 a day, ±95% 4 to 9%); the full run of 2026-09-29 measured the stored estimates 5.1% to 254.7% above it (mean +90.9%), while the reference itself sat +4.6% from growthepie, in step with the ArbOS share shown. The stored sample days use fixed-offset 3-second slices (KL-28) and overestimate: the difference is reported as it is (KL-37; option (c), user decision 2026-09-29). Re-run the dense check with <code className="font-mono">npm run cross-verify</code>.
            </p>
          </>
        )}
      </Section>

      <Section title="Dataset catalog" note="The stored tables and what fills them.">
        <table className={`${table} max-w-[980px]`}>
          <thead>
            <tr>
              {["Table", "Columns", "Filled by"].map((h) => (
                <th key={h} scope="col" className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATALOG.map((r) => (
              <tr key={r.table}>
                <td className={`${td} font-mono whitespace-nowrap`}>{r.table}</td>
                <td className={`${td} font-mono text-[11px] text-mute`}>{r.columns}</td>
                <td className={`${td} text-mute`}>{r.filled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Exports" note="CSV, read-only, the same rows the API serves. Bounds are enforced with HTTP 400; the first line of each file names the dataset, n and the window.">
        <ul className="space-y-1.5 text-[12px]">
          {Object.entries(EXPORT_DATASETS).map(([key, d]) => {
            const bounds = [`at most ${d.maxSpanMs === null ? "the whole table" : `${Math.round(d.maxSpanMs / DAY)} day(s)`}`, d.rowCap === null ? null : `at most ${int.format(d.rowCap)} rows`].filter(Boolean).join(", ");
            return (
              <li key={key} className="flex flex-wrap items-baseline gap-x-2">
                <a href={`/api/v1/export/${key}.csv`} className="font-mono text-text underline decoration-mute underline-offset-2 hover:decoration-text">
                  {key}.csv
                </a>
                <span className="text-mute">
                  {d.note} ({bounds})
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 max-w-[92ch] text-[11px] text-mute">
          Datasets with a time column default to the window ending with the newest ingested block. The public API is documented at{" "}
          <a href="/api" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
            /api
          </a>
          .
        </p>
      </Section>

      <Section title="Retention" note="As it stands today; nothing here is deleted silently.">
        <ul className="max-w-[92ch] list-disc space-y-1 pl-5 text-[12px] text-mute">
          <li>
            The database runs on the Neon free branch (0.5 GB); the Collector is run in bounded runs until the storage decision (KL-1), so history may be trimmed rather than grown.
          </li>
          <li>Transactions live in daily partitions; the partitions stay until the storage decision says otherwise.</li>
          <li>Facts are pruned after 30 days unless an insight or a Dispatch report cites them; every report keeps the facts it rests on.</li>
          <li>Insights are replaced with each engine run; the active set is the run from the last 25 hours.</li>
          <li>Dispatch reports, Surveyor answers and the token list are kept.</li>
        </ul>
      </Section>
    </ProfileShell>
  );
}
