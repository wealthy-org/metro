import { Redis } from "@upstash/redis";
import { log } from "../collector/log.ts";

// The account's model budget, kept in Redis because serverless functions keep no memory (Phase 10 D6; PROJECT.md
// 13.4.6): a global daily counter of OpenRouter calls (default 45, well under the 50 a free account gets) and the
// free tier's 20 calls per minute. Redis unreachable: the budget fails open (an ask still runs, bounded by the
// per-user limit) and the failure is logged. The same Redis is reused by Phase 12 for per-IP rate limits.

const MINUTE_CAP = 20;
const DAY_TTL_S = 2 * 86_400;
const MINUTE_TTL_S = 120;
const MODEL_LIST_KEY = "analyst:models";
const MODEL_LIST_TTL_S = 36 * 3_600;

export function globalDailyCalls(): number {
  const v = Number.parseInt(process.env.ASK_GLOBAL_DAILY_CALLS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 45;
}

let client: Redis | null = null;
function redis(): Redis {
  return (client ??= new Redis({ url: process.env.UPSTASH_REDIS_REST_URL ?? "", token: process.env.UPSTASH_REDIS_REST_TOKEN ?? "" }));
}

const dayKey = (d = new Date()) => `ask:calls:${d.toISOString().slice(0, 10)}`;
const minuteKey = (d = new Date()) => `ask:minute:${d.toISOString().slice(0, 16)}`;

export type Spend = { ok: boolean; reason?: "day" | "minute"; used: number; degraded: boolean };

// One model call. `ok: false` means the budget is spent and the ladder must fall to the Template.
export async function spendCall(): Promise<Spend> {
  try {
    const r = redis();
    const [day, minute] = await Promise.all([r.incr(dayKey()), r.incr(minuteKey())]);
    await Promise.all([day === 1 ? r.expire(dayKey(), DAY_TTL_S) : Promise.resolve(), minute === 1 ? r.expire(minuteKey(), MINUTE_TTL_S) : Promise.resolve()]);
    if (minute > MINUTE_CAP) return { ok: false, reason: "minute", used: day, degraded: false };
    if (day > globalDailyCalls()) return { ok: false, reason: "day", used: day, degraded: false };
    return { ok: true, used: day, degraded: false };
  } catch (err) {
    log("warn", "ask budget unavailable", { source: "analyst", error: err instanceof Error ? err.message : String(err) });
    return { ok: true, used: -1, degraded: true };
  }
}

// The ids that still exist and are free, written by the daily cron (PROJECT.md 13.4.5). null when unknown: the ladder
// then tries every configured model and steps down on the failures that come back.
export async function storeModelList(ids: string[]): Promise<void> {
  await redis().set(MODEL_LIST_KEY, ids, { ex: MODEL_LIST_TTL_S });
}

export async function availableModels(): Promise<string[] | null> {
  try {
    const v = await redis().get<string[]>(MODEL_LIST_KEY);
    return Array.isArray(v) ? v : null;
  } catch (err) {
    log("warn", "model list unavailable", { source: "analyst", error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// A small pointer to the newest answer of a topic, used by /subsidy (12.4) to show the latest subsidy summary.
export async function setLatestAnswer(topic: string, id: string): Promise<void> {
  try {
    await redis().set(`ask:latest:${topic}`, id, { ex: 90_000 });
  } catch {
    // A missing pointer only means /subsidy shows its empty state.
  }
}

export async function latestAnswerId(topic: string): Promise<string | null> {
  try {
    const v = await redis().get<string>(`ask:latest:${topic}`);
    return typeof v === "string" && v.length ? v : null;
  } catch {
    return null;
  }
}
