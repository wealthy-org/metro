import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { dispatch as dispatchTable } from "../../../db/schema.ts";
import { Markdown } from "../../../components/dispatch/Markdown.tsx";
import { ReportActions } from "../../../components/dispatch/ReportActions.tsx";
import { ProfileShell } from "../../../components/profile/Profile.tsx";
import { utcMinute as utc } from "../../../lib/format.ts";
import { getDb } from "../../../server/http.ts";

// /dispatch/[id] (PROJECT.md 7, 14.1): one report, public and shareable, with Download Markdown, the browser's print
// dialog for PDF (Phase 11 D1) and a copy-link button. Server-rendered from body_md.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const KIND_LABEL: Record<string, string> = { daily: "Daily report", custom: "Custom report", subsidy_impact: "Subsidy impact report" };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  return { title: `Dispatch ${id}, Metro` };
}

export default async function DispatchReportPage({ params }: Params) {
  const { id } = await params;
  const [report] = await getDb()
    .select({ id: dispatchTable.id, kind: dispatchTable.kind, rangeLabel: dispatchTable.rangeLabel, bodyMd: dispatchTable.bodyMd, modelUsed: dispatchTable.modelUsed, createdAt: dispatchTable.createdAt })
    .from(dispatchTable)
    .where(eq(dispatchTable.id, id))
    .limit(1);
  if (!report) notFound();
  return (
    <ProfileShell kind="Dispatch">
      <header className="print:mb-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[26px] leading-none font-bold">{KIND_LABEL[report.kind] ?? report.kind}</h1>
          <span className="rounded-[3px] border border-line px-1.5 py-px font-mono text-[10px] tracking-[0.08em] text-mute uppercase">{report.rangeLabel}</span>
        </div>
        <p className="mt-2 text-[12px] text-mute">
          Written {utc(report.createdAt.toISOString())} · prose by {report.modelUsed} · every number checked against the facts it cites
        </p>
      </header>
      <div className="mt-3">
        <ReportActions id={report.id} body={report.bodyMd} title={report.id} />
      </div>
      <section className="mt-4 rounded-[3px] border border-line bg-panel p-5 print:border-0 print:bg-white print:p-0">
        <Markdown body={report.bodyMd} />
      </section>
    </ProfileShell>
  );
}
