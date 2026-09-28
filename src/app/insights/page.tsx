import type { Metadata } from "next";
import Link from "next/link";
import { InsightCard } from "../../components/insights/InsightCard.tsx";
import { ProfileShell } from "../../components/profile/Profile.tsx";
import { RULES } from "../../engine/insights.ts";
import { utcMinute } from "../../lib/format.ts";
import { getDb } from "../../server/http.ts";
import { getInsights, parseInsightQuery, type InsightQuery } from "../../server/insights.ts";

// /insights (PROJECT.md 7): every active insight with filters by rule, status and severity. The filters live in the
// query string, so a filtered list can be shared. Each card states n and window and links its evidence (AT 15/16).

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Insights, Metro" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const chip = (on: boolean) =>
  `rounded-[3px] border px-[9px] py-[4px] text-[12px] no-underline ${on ? "border-accent text-accent" : "border-line text-mute hover:border-mute hover:text-text"}`;

function href(q: InsightQuery, patch: Partial<InsightQuery>): string {
  const n = { ...q, ...patch };
  const p = new URLSearchParams();
  if (n.rule) p.set("rule", n.rule);
  if (n.status) p.set("status", n.status);
  if (n.severity) p.set("severity", n.severity);
  const s = p.toString();
  return s ? `/insights?${s}` : "/insights";
}

export default async function InsightsPage({ searchParams }: Props) {
  const raw = await searchParams;
  const params = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const parsed = parseInsightQuery(params);
  const q: InsightQuery = typeof parsed === "string" ? { rule: null, status: null, severity: null } : parsed;
  const data = await getInsights(getDb(), q);

  return (
    <ProfileShell kind="Insights">
      <h1 className="font-display text-[34px] leading-none font-bold">Insights</h1>
      <p className="mt-3 max-w-[72ch] text-[14px] text-mute">
        Findings from ten fixed rules over the Ledger of Facts. Every one states its sample and window, and links the view that shows the same number. A rule with fewer than {data.min_sample} samples is listed as &quot;not enough data&quot; instead of a finding.{" "}
        <a href="/methodology" className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
          Methodology
        </a>
      </p>
      {typeof parsed === "string" ? (
        <p role="status" className="mt-3 text-[12px] text-c2">
          {parsed}. Showing every insight.
        </p>
      ) : null}

      <nav aria-label="Filter insights" className="mt-5 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 text-[11px] tracking-[0.08em] text-mute uppercase">Status</span>
          <Link href={href(q, { status: null })} className={chip(!q.status)} aria-current={!q.status ? "page" : undefined}>All</Link>
          <Link href={href(q, { status: "finding" })} className={chip(q.status === "finding")} aria-current={q.status === "finding" ? "page" : undefined}>Findings</Link>
          <Link href={href(q, { status: "not_enough_data" })} className={chip(q.status === "not_enough_data")} aria-current={q.status === "not_enough_data" ? "page" : undefined}>Not enough data</Link>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 text-[11px] tracking-[0.08em] text-mute uppercase">Severity</span>
          <Link href={href(q, { severity: null })} className={chip(!q.severity)} aria-current={!q.severity ? "page" : undefined}>All</Link>
          <Link href={href(q, { severity: "attention" })} className={chip(q.severity === "attention")} aria-current={q.severity === "attention" ? "page" : undefined}>Attention</Link>
          <Link href={href(q, { severity: "info" })} className={chip(q.severity === "info")} aria-current={q.severity === "info" ? "page" : undefined}>Info</Link>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 text-[11px] tracking-[0.08em] text-mute uppercase">Rule</span>
          <Link href={href(q, { rule: null })} className={chip(!q.rule)} aria-current={!q.rule ? "page" : undefined}>All</Link>
          {RULES.map((r) => (
            <Link key={r.rule} href={href(q, { rule: r.rule })} className={chip(q.rule === r.rule)} aria-current={q.rule === r.rule ? "page" : undefined}>
              {r.title}
            </Link>
          ))}
        </div>
      </nav>

      <p className="mt-4 mb-3 font-mono text-[12px] text-mute">
        {data.total} insight{data.total === 1 ? "" : "s"}, {data.findings} finding{data.findings === 1 ? "" : "s"}
        {data.computed_at ? ` · computed ${utcMinute(data.computed_at)}` : ""}
      </p>
      {data.insights.length ? (
        <div className="grid grid-cols-2 gap-x-3">
          {data.insights.map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      ) : (
        <p className="text-[14px] text-mute">{q.rule || q.status || q.severity ? "No active insight matches these filters." : "No insight has been computed yet. The rules run with the Collector and once a day."}</p>
      )}
    </ProfileShell>
  );
}
