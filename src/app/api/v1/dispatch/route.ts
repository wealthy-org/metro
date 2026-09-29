import { desc } from "drizzle-orm";
import { dispatch as dispatchTable } from "../../../../db/schema.ts";
import { getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/dispatch lists the stored reports, newest first (Phase 11). The body of one report is at
// /api/v1/dispatch/:id (section 1.9 of api.md).
export async function GET() {
  try {
    const rowsOut = await getDb()
      .select({ id: dispatchTable.id, kind: dispatchTable.kind, range_label: dispatchTable.rangeLabel, model_used: dispatchTable.modelUsed, created_at: dispatchTable.createdAt })
      .from(dispatchTable)
      .orderBy(desc(dispatchTable.createdAt))
      .limit(50);
    return Response.json({ total: rowsOut.length, dispatch: rowsOut, generated_at: new Date().toISOString() }, { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
