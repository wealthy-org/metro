import { createDb, type Db } from "../db/client.ts";

let db: Db | null = null;

// One small pool per server instance for read routes.
export const getDb = () => (db ??= createDb(process.env.DATABASE_URL, 3).db);

export const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: { "cache-control": "no-store" } });
}

export function serverError(): Response {
  return Response.json({ error: "data unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}
