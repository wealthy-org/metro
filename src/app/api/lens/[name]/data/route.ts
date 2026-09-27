import { CITY_WINDOWS, isCityWindow } from "../../../../../lib/city.ts";
import { getCity } from "../../../../../server/city.ts";
import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../../server/http.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 18: GET /api/lens/[name]/data. Only the City lens exists so far; other lenses arrive in later phases.
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (name !== "city") {
    return Response.json({ error: "lens not available" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const window = new URL(request.url).searchParams.get("window") ?? "24h";
  if (!isCityWindow(window)) return badRequest(`window must be one of ${CITY_WINDOWS.map((w) => w.key).join(", ")}`);
  try {
    return Response.json(await getCity(getDb(), window), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
