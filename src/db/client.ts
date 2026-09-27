import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url = process.env.DATABASE_URL, max = 5): { db: Db; pool: pg.Pool } {
  if (!url) throw new Error("DATABASE_URL is not set");
  // Neon connection strings ask for channel binding; pg only uses it when enabled explicitly.
  const pool = new pg.Pool({ connectionString: url, enableChannelBinding: true, max });
  return { db: drizzle(pool, { schema }), pool };
}
