import { getLaunchpad } from "../../../../server/launchpad.ts";
import { anchorAt } from "../../../../server/filters.ts";
import { getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { NO_FILTERS } from "../../../../lib/view-state.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/tokens, the Pons tokens with the Launchpad figures over the last 24 h, including the
// newest launches not ingested yet (KL-24).
export async function GET() {
  try {
    const db = getDb();
    const body = await getLaunchpad(db, { window: "24h", filters: NO_FILTERS, live: true }, await anchorAt(db, null));
    return Response.json(body, { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
