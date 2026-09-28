import { getInspector, parseInspectorParams } from "../../../server/city.ts";
import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../server/http.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 18: GET /api/inspector?kind=action|token|hour&key=&window=&…filters&at= (details of the selected
// object in any lens, 11.1).
export async function GET(request: Request) {
  const params = parseInspectorParams(new URL(request.url).searchParams);
  if (typeof params === "string") return badRequest(params);
  try {
    const body = await getInspector(getDb(), params);
    if (!body) return Response.json({ error: "not a known Pons token" }, { status: 404, headers: { "cache-control": "no-store" } });
    return Response.json(body, { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
