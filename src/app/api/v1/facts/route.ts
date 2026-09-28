import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { getFacts, isFactPrefix } from "../../../../server/insights.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/facts?prefix=, the computed facts (13.1) whose key starts with the prefix, newest first.
export async function GET(request: Request) {
  const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
  if (!isFactPrefix(prefix)) return badRequest("prefix may hold only a-z, 0-9, _ and . (at most 128 characters)");
  try {
    return Response.json(await getFacts(getDb(), prefix), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
