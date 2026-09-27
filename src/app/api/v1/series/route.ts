import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { getSeries, parseSeriesParams } from "../../../../server/metrics.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/series?metric=&window=&bucket=
export async function GET(request: Request) {
  const params = parseSeriesParams(new URL(request.url).searchParams);
  if (typeof params === "string") return badRequest(params);
  try {
    const series = await getSeries(getDb(), params);
    if ("error" in series) return badRequest(series.error);
    return Response.json(series, { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
