import type { Metadata } from "next";
import { ApiExample } from "../../components/api/ApiExample.tsx";
import { ProfileShell, Section } from "../../components/profile/Profile.tsx";

// /api (PROJECT.md 7; Phase 12): the public read API built from api.md. Every endpoint is listed with its parameters,
// limits and errors, a live example response and a copyable curl line. The page sits beside the handlers under
// /api/*; "api" itself is not a route handler, so there is no clash.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API, Metro" };

type Endpoint = { path: string; what: string; params: string; errors: string; example?: string };

const PUBLIC: Endpoint[] = [
  {
    path: "/api/v1/stats",
    what: "The Ticker readout: chain head and lag, gas price, transactions per second, blended and median fees, subsidy share, ETH price, chain TVL, fees and revenue. The top-level n and window are the widest sample (24 h); each metric carries its own.",
    params: "none",
    errors: "503 when the database is unreachable",
    example: "/api/v1/stats",
  },
  {
    path: "/api/v1/series",
    what: "One metric over time, in buckets.",
    params: "metric = tx_count | gas_volume | avg_fee_usd | wallets | fail_rate | gas_price; window = 1h | 24h | 7d | 30d | all; bucket = 1m | 5m | 15m | 1h | 4h | 1d | 1w (bucket must fit the window)",
    errors: '400 { "error": "..." } for a bad metric, window or bucket',
    example: "/api/v1/series?metric=tx_count&window=24h&bucket=1h",
  },
  {
    path: "/api/v1/breakdown",
    what: "Transactions (and gas and fees) grouped by action type or by subsidy class.",
    params: "by = action | subsidy; window = 24h | 7d | 30d",
    errors: "400 for a bad by or window",
    example: "/api/v1/breakdown?by=action&window=24h",
  },
  {
    path: "/api/v1/heatmap",
    what: "The hour-by-day matrix of the Heatmap lens: rows are UTC calendar days, cells[d][h] is day days[d] at hour h.",
    params: "metric = tx_count | gas_volume | avg_fee_usd | gas_price; window = 7d | 30d | all (matrices); mode = days | compare; the shared filters below",
    errors: "400 for a bad metric or mode",
    example: "/api/v1/heatmap?metric=tx_count&window=7d",
  },
  {
    path: "/api/v1/insights",
    what: "The active insight set, findings first, each with its sample n, window and evidence link.",
    params: "rule (one of the 10 rule ids), status = finding | not_enough_data, severity = info | attention",
    errors: "400 for an unknown rule, status or severity",
    example: "/api/v1/insights",
  },
  {
    path: "/api/v1/facts",
    what: "The Ledger of Facts every number in Metro comes from, newest computation first.",
    params: "prefix = a-z, 0-9, _ and . only, at most 128 characters; empty lists everything; at most 500 rows",
    errors: "400 for characters outside the set or an over-long prefix",
    example: "/api/v1/facts?prefix=median_fee_usd.swap",
  },
  {
    path: "/api/v1/subsidy",
    what: "The Subsidy Cliff figures per window: rates over covered blocks, estimated transactions per day, paid share and classes, medians, the bot-pattern rate and the sender retention. n and window cover both windows together.",
    params: "before = YYYY-MM-DD..YYYY-MM-DD and after = YYYY-MM-DD..YYYY-MM-DD (default: 7 whole UTC days either side of the subsidy end)",
    errors: "400 for a malformed or reversed window",
    example: "/api/v1/subsidy",
  },
  {
    path: "/api/v1/tokens",
    what: "The Pons tokens with their Launchpad figures over the last 24 h (the same body as the Launchpad lens).",
    params: "none",
    errors: "503 when the database is unreachable",
    example: "/api/v1/tokens",
  },
  {
    path: "/api/v1/tokens/<address>",
    what: "One token profile: launch, supply, holders and top-10 share, market, the last 7 days of activity and the newest transfers. n and window cover that 7-day profile window.",
    params: "address = 0x + 40 hex",
    errors: '400 for a malformed address; 404 { "error": "not a token" } when the address is neither stored nor an ERC-20 on the chain',
    example: "/api/v1/tokens/0xc40b3c8f4443cfca0696a63b96ffe43f579d5486",
  },
  {
    path: "/api/v1/dispatch",
    what: "The written reports, newest first: id, kind, range_label, model_used, created_at; one report at /api/v1/dispatch/<id> with the Markdown body and the facts every number traces to.",
    params: "none; :id is the report id (daily-YYYY-MM-DD, subsidy-impact or a UUID)",
    errors: '404 { "error": "not found" } for an unknown id',
    example: "/api/v1/dispatch",
  },
];

const day = (v: string) => <code className="font-mono text-[11px]">{v}</code>;

export default function ApiPage() {
  return (
    <ProfileShell kind="API">
      <h1 className="font-display text-[34px] leading-none font-bold">API</h1>
      <p className="mt-2 max-w-[92ch] text-[13px] text-mute">
        Read-only and unauthenticated. Every response carries <code className="font-mono text-[12px]">n</code>, its window and{" "}
        <code className="font-mono text-[12px]">generated_at</code>; invalid parameters return 400{" "}
        <code className="font-mono text-[12px]">{`{ "error": "..." }`}</code> and a database failure 503{" "}
        <code className="font-mono text-[12px]">{`{ "error": "data unavailable" }`}</code>. Reads are cached{" "}
        <code className="font-mono text-[12px]">public, s-maxage=10, stale-while-revalidate=30</code> (the live Flow read 2 s; /api/health none).
      </p>

      <Section title="Limits" note="Per network address, hashed with a salt; the raw IP is never stored. Windows are sliding.">
        <ul className="max-w-[92ch] list-disc space-y-1 pl-5 text-[12px] text-mute">
          <li>120 requests a minute on /api/v1/*, /api/lens/* and /api/inspector.</li>
          <li>10 requests a minute on POST /api/ask and POST /api/dispatch, on top of the daily Surveyor quota.</li>
          <li>120 page requests a minute on /tx/*, /token/* and /wallet/*, counted separately so page views never consume the API budget.</li>
          <li>
            Allowed responses carry <code className="font-mono text-[11px]">RateLimit-Limit</code>,{" "}
            <code className="font-mono text-[11px]">RateLimit-Remaining</code> and <code className="font-mono text-[11px]">RateLimit-Reset</code>; a blocked request gets 429 with{" "}
            <code className="font-mono text-[11px]">Retry-After</code>. /api/health and /api/cron/* are not limited. When the limiter store cannot be reached, requests pass.
          </li>
        </ul>
      </Section>

      <Section title="Shared filters" note="The lens query of the views, per api.md 2.0.">
        <p className="max-w-[92ch] text-[12px] text-mute">
          <code className="font-mono text-[11px]">window</code> = 1h | 24h (default) | 7d | 30d | all;{" "}
          <code className="font-mono text-[11px]">action</code> = one of the seven action keys;{" "}
          <code className="font-mono text-[11px]">token</code> (0x address), <code className="font-mono text-[11px]">min_value</code> (ETH),{" "}
          <code className="font-mono text-[11px]">wallet</code> = robinhood | other | unknown and <code className="font-mono text-[11px]">status</code> = success | failed apply to windows of 24 h or less;{" "}
          <code className="font-mono text-[11px]">at</code> = an ISO minute scrubs the view to that time.
        </p>
      </Section>

      {PUBLIC.map((e) => (
        <Section key={e.path} title={e.path} note={e.what}>
          <p className="text-[12px] text-mute">
            <span className="text-[11px] tracking-[0.08em] uppercase">Parameters:</span> {e.params.startsWith("none") ? "none" : e.params}
          </p>
          <p className="mt-1 text-[12px] text-mute">
            <span className="text-[11px] tracking-[0.08em] uppercase">Errors:</span> {e.errors}
          </p>
          {e.example ? <ApiExample path={e.example} /> : null}
        </Section>
      ))}

      <Section title="CSV exports" note="Bounded raw datasets; the first line names the dataset, n and the window.">
        <p className="text-[12px] text-mute">
          <code className="font-mono text-[11px]">GET /api/v1/export/&#123;dataset&#125;.csv</code>, dataset ={" "}
          {day("txs")} | {day("blocks")} | {day("agg_minute")} | {day("agg_day")} | {day("facts")} | {day("insights")} | {day("tokens")}. Bounds: txs at most 24 h and 50,000 rows, blocks at
          most 24 h, agg_minute at most 7 days, whole tables otherwise; out of bounds is 400. The catalog and per-table notes are on{" "}
          <a href="/data" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
            /data
          </a>
          .
        </p>
        <pre className="mt-2 overflow-auto rounded-[3px] border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {[
            "# Metro export: facts; n = 325; window whole table; generated 2026-09-29T11:09:50.173Z",
            "id,key,window_start,window_end,value,n,computed_at",
            "1,median_fee_usd.swap.hour,2026-09-27 06:00:00+00,2026-09-27 07:00:00+00,0.012661398902,758,2026-09-28 10:37:39.4+00",
          ].join("\n")}
        </pre>
      </Section>

      <Section title="App routes" note="Used by the pages; the same limits apply.">
        <ul className="max-w-[92ch] list-disc space-y-1 pl-5 text-[12px] text-mute">
          <li>GET /api/lens/&lt;name&gt;/data: render-ready data for one lens and its filters (city, terrain, heatmap, flow, launchpad, split, graph).</li>
          <li>GET /api/inspector: the details of one selected object.</li>
          <li>POST /api/ask: Surveyor, one question, daily quota.</li>
          <li>POST /api/dispatch: build a custom report over a range, lens pictures and sections.</li>
          <li>GET /api/health: Collector telemetry, never cached, never limited.</li>
        </ul>
      </Section>
    </ProfileShell>
  );
}
