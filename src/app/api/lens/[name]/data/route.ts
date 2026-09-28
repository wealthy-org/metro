import { getCity } from "../../../../../server/city.ts";
import { anchorAt, parseDataParams } from "../../../../../server/filters.ts";
import { getHeatmap, heatmapIssue } from "../../../../../server/heatmap.ts";
import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../../server/http.ts";
import { getTerrain, terrainIssue } from "../../../../../server/terrain.ts";
import { isMetric, METRICS } from "../../../../../lib/view-state.ts";

export const dynamic = "force-dynamic";

const LENSES = ["city", "terrain", "heatmap"];

// PROJECT.md 18: GET /api/lens/[name]/data, render-ready data for one lens and its filters (11.2). Lenses that are
// not built yet return 404 until their phase.
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!LENSES.includes(name)) {
    return Response.json({ error: "lens not available" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const params = new URL(request.url).searchParams;
  const data = parseDataParams(params);
  if (typeof data === "string") return badRequest(data);

  const metric = params.get("metric") ?? "tx_count";
  const rows = params.get("rows") ?? "actions";
  const mode = params.get("mode") ?? "days";

  try {
    const db = getDb();
    if (name === "city") {
      return Response.json(await getCity(db, data.window, await anchorAt(db, data.at), data.filters), { headers: { "cache-control": PUBLIC_CACHE } });
    }
    if (!isMetric(metric)) return badRequest(`metric must be one of ${METRICS.map((m) => m.key).join(", ")}`);
    if (name === "terrain") {
      if (rows !== "actions" && rows !== "tokens") return badRequest("rows must be actions or tokens");
      const p = { window: data.window, metric, rows, filters: data.filters } as const;
      const issue = terrainIssue(p);
      if (issue) return badRequest(issue);
      return Response.json(await getTerrain(db, p, await anchorAt(db, data.at)), { headers: { "cache-control": PUBLIC_CACHE } });
    }
    if (mode !== "days" && mode !== "compare") return badRequest("mode must be days or compare");
    const p = { window: data.window, metric, mode, filters: data.filters } as const;
    const issue = heatmapIssue(p);
    if (issue) return badRequest(issue);
    return Response.json(await getHeatmap(db, p, await anchorAt(db, data.at)), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
