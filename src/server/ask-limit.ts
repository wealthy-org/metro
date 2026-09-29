import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { num, rows } from "./query.ts";

// Surveyor's identity and daily limit (PROJECT.md 13.3, 17; Phase 10 D3, AT 22). The browser gets an httpOnly cookie
// with a random id; without one the salted hash of the forwarding header keeps a cap per network, so clearing the
// cookie does not hand out a fresh quota. The raw IP is never stored. A cached answer does not count.

const COOKIE = "metro_user";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const IP_CAP_FACTOR = 3;

export function askDailyLimit(): number {
  const v = Number.parseInt(process.env.ASK_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 10;
}

export type AskIdentity = { userId: string; ipId: string | null; newCookie: string | null };

function cookieHeader(value: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${secure}`;
}

export function identity(request: Request): AskIdentity {
  const header = request.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(header);
  const given = m?.[1]?.trim() ?? "";
  const userId = UUID.test(given) ? `c:${given}` : `c:${randomUUID()}`;
  const newCookie = UUID.test(given) ? null : cookieHeader(userId.slice(2));
  // Vercel sets x-real-ip, and appends the client to the end of x-forwarded-for; an entry a client put at the front
  // is never trusted. No header (local dev) means no IP cap.
  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = (request.headers.get("x-real-ip") ?? "").trim() || forwarded.at(-1) || "";
  const salt = process.env.IP_HASH_SALT ?? "";
  const ipId = ip ? `ip:${createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32)}` : null;
  return { userId, ipId, newCookie };
}

export type Quota = { limit: number; used: number; remaining: number; allowed: boolean; reason: "user" | "ip" | null; reset: string };

const nextUtcMidnight = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
};

export async function checkQuota(db: Db, id: AskIdentity): Promise<Quota> {
  const limit = askDailyLimit();
  const ids = [id.userId, ...(id.ipId ? [id.ipId] : [])];
  const out = await rows(db, sql`SELECT id, daily_ask_count, last_ask_date FROM users WHERE id = ANY(${sql.param(ids)}::varchar[])`);
  const today = new Date().toISOString().slice(0, 10);
  const count = (rowId: string) => {
    const r = out.find((x) => String(x.id) === rowId);
    if (!r) return 0;
    const d = r.last_ask_date;
    const date = d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === "string" ? d.slice(0, 10) : "";
    return date === today ? num(r.daily_ask_count) : 0;
  };
  const used = count(id.userId);
  const ipUsed = id.ipId ? count(id.ipId) : 0;
  const reason = used >= limit ? "user" : ipUsed >= limit * IP_CAP_FACTOR ? "ip" : null;
  return { limit, used, remaining: Math.max(0, limit - used), allowed: reason === null, reason, reset: nextUtcMidnight().toISOString() };
}

export async function countAsk(db: Db, id: AskIdentity): Promise<void> {
  const ids = [id.userId, ...(id.ipId ? [id.ipId] : [])];
  for (const row of ids) {
    await db.execute(sql`
      INSERT INTO users (id, daily_ask_count, last_ask_date) VALUES (${row}, 1, CURRENT_DATE)
      ON CONFLICT (id) DO UPDATE
      SET daily_ask_count = CASE WHEN users.last_ask_date = CURRENT_DATE THEN users.daily_ask_count + 1 ELSE 1 END,
          last_ask_date = CURRENT_DATE`);
  }
}
