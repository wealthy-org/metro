import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { getBreakdown, parseBreakdownParams } from "../../../../server/metrics.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/breakdown?by=action&window=
export async function GET(request: Request) {
  const params = parseBreakdownParams(new URL(request.url).searchParams);
  if (typeof params === "string") return badRequest(params);
  try {
    return Response.json(await getBreakdown(getDb(), params), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
