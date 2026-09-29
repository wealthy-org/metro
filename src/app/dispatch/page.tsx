import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { dispatch as dispatchTable } from "../../db/schema.ts";
import { Markdown } from "../../components/dispatch/Markdown.tsx";
import { ReportBuilder } from "../../components/dispatch/ReportBuilder.tsx";
import { ProfileShell, Section } from "../../components/profile/Profile.tsx";
import { coverage } from "../../server/filters.ts";
import { getDb } from "../../server/http.ts";
import { utcMinute as utc } from "../../lib/format.ts";

// /dispatch (PROJECT.md 7, 14): the archive of written reports, the newest subsidy report, and the custom builder
// (Phase 11). Reports are written by the daily cron and by POST /api/dispatch.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dispatch, Metro" };

const KIND_LABEL: Record<string, string> = { daily: "Daily", custom: "Custom", subsidy_impact: "Subsidy impact" };

export default async function DispatchPage() {
  const db = getDb();
  const [reports, cov] = await Promise.all([
    db.select({ id: dispatchTable.id, kind: dispatchTable.kind, rangeLabel: dispatchTable.rangeLabel, modelUsed: dispatchTable.modelUsed, createdAt: dispatchTable.createdAt, bodyMd: dispatchTable.bodyMd }).from(dispatchTable).orderBy(desc(dispatchTable.createdAt)).limit(50),
    coverage(db),
  ]);
  const subsidy = reports.find((r) => r.kind === "subsidy_impact");
  const firstDay = cov.first?.slice(0, 10) ?? "";
  const lastDay = cov.last?.slice(0, 10) ?? "";
  const summaryOf = (md: string) => {
    const m = /## Summary\n\n([^\n]+)/.exec(md);
    return m?.[1] ?? "";
  };
  return (
    <ProfileShell kind="Dispatch">
      <h1 className="font-display text-[34px] leading-none font-bold">Dispatch</h1>
      <p className="mt-2 max-w-[92ch] text-[13px] text-mute">
        Written reports from the same Ledger of Facts as everything else: a daily report for the previous UTC day, the subsidy impact report refreshed each day, and custom reports over any range inside the ingested data. Every number in a report traces to a fact, and each report page prints cleanly or downloads as Markdown.
      </p>

      <Section title="Subsidy impact" note="Rebuilt each day from the Subsidy Cliff facts; while the after window has too little data, it says so.">
        {subsidy ? (
          <>
            <p className="max-w-[92ch] text-[13px]">{summaryOf(subsidy.bodyMd)}</p>
            <p className="mt-2 text-[11px] text-mute">
              {KIND_LABEL[subsidy.kind]} · {subsidy.rangeLabel} · written {utc(subsidy.createdAt.toISOString())} ·{" "}
              <a href={`/dispatch/${subsidy.id}`} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
                open the report
              </a>
            </p>
          </>
        ) : (
          <p className="text-[12px] text-mute">No subsidy report has been written yet. The daily cron writes one after its first run.</p>
        )}
      </Section>

      <Section title="Reports" note="Newest first; at most 50 are listed.">
        {reports.length ? (
          <table className="w-full max-w-[720px] border-collapse text-[12px]">
            <thead>
              <tr className="text-[10px] tracking-[0.08em] text-mute uppercase">
                {["Report", "Kind", "Range", "Written"].map((h, i) => (
                  <th key={h} scope="col" className={`border-b border-line px-1.5 py-1.5 font-medium ${i === 3 ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td className="border-b border-line px-1.5 py-[7px]">
                    <a href={`/dispatch/${r.id}`} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
                      {r.id}
                    </a>
                  </td>
                  <td className="border-b border-line px-1.5 py-[7px]">{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className="border-b border-line px-1.5 py-[7px] font-mono">{r.rangeLabel}</td>
                  <td className="border-b border-line px-1.5 py-[7px] text-right font-mono">{utc(r.createdAt.toISOString())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[12px] text-mute">Nothing written yet.</p>
        )}
      </Section>

      <Section title="Custom report" note="Pick a range; the report is stored with its own permalink and counts as one Surveyor question.">
        {firstDay && lastDay ? <ReportBuilder firstDay={firstDay} lastDay={lastDay} /> : <p className="text-[12px] text-mute">Nothing is ingested yet, so there is nothing to report on.</p>}
      </Section>

      {subsidy ? (
        <details className="mt-6 text-[12px] text-mute">
          <summary className="cursor-pointer">Newest subsidy report as Markdown</summary>
          <div className="mt-2 rounded-[3px] border border-line bg-bg p-3">
            <Markdown body={subsidy.bodyMd} />
          </div>
        </details>
      ) : null}
    </ProfileShell>
  );
}
