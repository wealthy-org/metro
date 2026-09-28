import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../server/http.ts";
import { getSubsidy, parseSubsidyParams } from "../../../../server/subsidy.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/subsidy, the Subsidy Cliff metrics (12.3) for 7 days before and after SUBSIDY_END_DATE,
// or for `before=YYYY-MM-DD..YYYY-MM-DD&after=…` (the comparator, 11.4).
export async function GET(request: Request) {
  const p = parseSubsidyParams(new URL(request.url).searchParams);
  if (typeof p === "string") return badRequest(p);
  try {
    return Response.json(await getSubsidy(getDb(), p), { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
