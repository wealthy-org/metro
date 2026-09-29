import { anchorAt, parseDataParams } from "../../../../server/filters.ts";
import { getHeatmap, heatmapIssue } from "../../../../server/heatmap.ts";
import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { isMetric, METRICS } from "../../../../lib/view-state.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/heatmap (Phase 12). The same body as the Heatmap lens (api.md 1.4): rows are UTC
// calendar days, `cells[d][h]` is day days[d], hour h; median fee is not offered per cell (KL-17).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const data = parseDataParams(params);
  if (typeof data === "string") return badRequest(data);
  const metric = params.get("metric") ?? "tx_count";
  const mode = params.get("mode") ?? "days";
  try {
    if (!isMetric(metric)) return badRequest(`metric must be one of ${METRICS.map((m) => m.key).join(", ")}`);
    if (mode !== "days" && mode !== "compare") return badRequest("mode must be days or compare");
    const p = { window: data.window, metric, mode, filters: data.filters } as const;
    const issue = heatmapIssue(p);
    if (issue) return badRequest(issue);
    const db = getDb();
    return Response.json(await getHeatmap(db, p, await anchorAt(db, data.at)), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
