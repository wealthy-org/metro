import { badRequest, getDb, PUBLIC_CACHE, serverError } from "../../../../../server/http.ts";
import { getToken } from "../../../../../server/token.ts";

export const dynamic = "force-dynamic";

// PROJECT.md 16: GET /api/v1/tokens/{address}, the token profile (PROJECT.md 15).
export async function GET(_request: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return badRequest("address must be a 0x token address");
  try {
    const body = await getToken(getDb(), address.toLowerCase());
    if (!body) return Response.json({ error: "not a token" }, { status: 404, headers: { "cache-control": "no-store" } });
    return Response.json(body, { headers: { "cache-control": PUBLIC_CACHE } });
  } catch {
    return serverError();
  }
}
