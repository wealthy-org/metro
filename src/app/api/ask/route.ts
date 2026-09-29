import type { ScopeInput } from "../../../analyst/topics.ts";
import { askSurveyor } from "../../../server/ask.ts";
import { identity } from "../../../server/ask-limit.ts";
import { badRequest, getDb, serverError } from "../../../server/http.ts";

export const dynamic = "force-dynamic";
// A ladder walk with retries can take a while; Vercel Hobby allows up to 60 s.
export const maxDuration = 60;

// PROJECT.md 18: POST /api/ask. The handler stays thin: check the shape, identify the caller, and let askSurveyor run
// the documented order (map, facts, cache, ladder, store). A spent quota is HTTP 429; a refusal is HTTP 200 with its
// reason and no model output. The cookie that carries the anonymous id is set here, httpOnly.
export async function POST(request: Request) {
  const noStore = { "cache-control": "no-store" };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("a JSON body is required");
  }
  const b = (body ?? {}) as { question?: unknown; scope?: unknown };
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (question.length < 3 || question.length > 300) return badRequest("question must be 3 to 300 characters");
  const scope = b.scope && typeof b.scope === "object" && !Array.isArray(b.scope) ? (b.scope as ScopeInput) : {};
  const id = identity(request);
  try {
    const { response, status } = await askSurveyor(getDb(), { question, scope, identity: id });
    const headers: Record<string, string> = { ...noStore };
    if (id.newCookie) headers["set-cookie"] = id.newCookie;
    return Response.json(response, { status, headers });
  } catch {
    return serverError();
  }
}
