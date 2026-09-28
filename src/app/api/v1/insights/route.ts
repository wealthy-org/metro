import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { getInsights, parseInsightQuery } from "../../../../server/insights.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/insights, the active insights with their n, window and evidence (13.2, AT 15/16).
// Optional filters: rule, status (finding | not_enough_data), severity (info | attention).
export async function GET(request: Request) {
  const q = parseInsightQuery(new URL(request.url).searchParams);
  if (typeof q === "string") return badRequest(q);
  try {
    return Response.json(await getInsights(getDb(), q), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
