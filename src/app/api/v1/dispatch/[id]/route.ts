import { eq, sql } from "drizzle-orm";
import { dispatch as dispatchTable } from "../../../../../db/schema.ts";
import { getDb, PUBLIC_CACHE, serverError } from "../../../../../server/http.ts";
import { num, rows } from "../../../../../server/query.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/dispatch/:id returns one stored report: the Markdown body, the facts its numbers came
// from, and the model that wrote its prose (Phase 11; api.md 1.9).
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const db = getDb();
    const [report] = await db
      .select({ id: dispatchTable.id, kind: dispatchTable.kind, range_label: dispatchTable.rangeLabel, body_md: dispatchTable.bodyMd, facts_ref: dispatchTable.factsRef, model_used: dispatchTable.modelUsed, created_at: dispatchTable.createdAt })
      .from(dispatchTable)
      .where(eq(dispatchTable.id, id))
      .limit(1);
    if (!report) return Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
    const facts = report.facts_ref.length
      ? await rows(db, sql`SELECT id, key, window_start, window_end, value, n FROM facts WHERE id = ANY(${sql.param(report.facts_ref)}::bigint[]) ORDER BY key, window_start`)
      : [];
    return Response.json(
      {
        ...report,
        facts: facts.map((f) => ({ id: num(f.id), key: String(f.key), window: { start: new Date(String(f.window_start)).toISOString(), end: new Date(String(f.window_end)).toISOString() }, value: num(f.value), n: num(f.n) })),
        generated_at: new Date().toISOString(),
      },
      { headers: { "cache-control": PUBLIC_CACHE } },
    );
  } catch {
    return serverError();
  }
}
