import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { CITY_ACTIONS, CITY_WINDOWS, isCityAction, isCityWindow, type CityWindow } from "../lib/city.ts";
import {
  ethToWei,
  isShortWindow,
  isoMinuteDate,
  NO_FILTERS,
  parseEthAmount,
  parseIsoMinute,
  RAW_FILTER_REASON,
  rawFilterCount,
  STATUSES,
  WALLET_CLASSES,
  type Filters,
  type TxStatus,
  type WalletClass,
} from "../lib/view-state.ts";

// Global filters (PROJECT.md 11.2) and the scrubber time for the lens and Inspector APIs. Unlike the URL parser in
// the browser, the API rejects invalid values with a 400 rather than silently dropping them.

export type DataParams = { window: CityWindow; filters: Filters; at: string | null };

export function parseDataParams(params: URLSearchParams): DataParams | string {
  const window = params.get("window") ?? "24h";
  if (!isCityWindow(window)) return `window must be one of ${CITY_WINDOWS.map((w) => w.key).join(", ")}`;
  const f: Filters = { ...NO_FILTERS };

  const action = params.get("action");
  if (action !== null) {
    if (!isCityAction(action)) return `action must be one of ${CITY_ACTIONS.map((a) => a.key).join(", ")}`;
    f.action = action;
  }
  const token = params.get("token");
  if (token !== null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return "token must be a token address";
    f.token = token.toLowerCase();
  }
  const minValue = params.get("min_value");
  if (minValue !== null) {
    const v = parseEthAmount(minValue);
    if (!v) return "min_value must be an ETH amount with at most 18 decimals";
    f.minValue = v;
  }
  const wallet = params.get("wallet");
  if (wallet !== null) {
    if (!WALLET_CLASSES.some((w) => w.key === wallet)) return `wallet must be one of ${WALLET_CLASSES.map((w) => w.key).join(", ")}`;
    f.wallet = wallet as WalletClass;
  }
  const status = params.get("status");
  if (status !== null) {
    if (!(STATUSES as readonly string[]).includes(status)) return `status must be one of ${STATUSES.join(", ")}`;
    f.status = status as TxStatus;
  }
  if (rawFilterCount(f) > 0 && !isShortWindow(window)) return RAW_FILTER_REASON;

  const atRaw = params.get("at");
  const at = atRaw === null ? null : parseIsoMinute(atRaw);
  if (atRaw !== null && !at) return "at must be an ISO minute such as 2026-09-27T15:51Z";
  return { window, filters: f, at };
}

// `AND …` conditions on a txs row. `t` is the table alias ("t" or "txs"), always a constant from this codebase.
export function txFilter(f: Filters, t: "t" | "txs"): SQL {
  const col = (c: string) => sql.raw(`${t}.${c}`);
  const parts: SQL[] = [];
  if (f.action) parts.push(sql`AND ${col("action")} = ${f.action}`);
  if (f.minValue) parts.push(sql`AND ${col("value")} >= ${ethToWei(f.minValue)}::numeric`);
  if (f.wallet) parts.push(sql`AND ${col("subsidy_class")} = ${WALLET_CLASSES.find((w) => w.key === f.wallet)?.subsidy ?? "unknown"}`);
  if (f.status) parts.push(sql`AND ${col("status")} = ${f.status === "success" ? 1 : 0}`);
  if (f.token) {
    parts.push(sql`AND EXISTS (SELECT 1 FROM token_transfers ft WHERE ft.tx_hash = ${col("hash")} AND ft.ts = ${col("ts")} AND ft.token_address = ${f.token})`);
  }
  return sql.join(parts, sql` `);
}

export const filterKey = (f: Filters) => [f.action, f.token, f.minValue, f.wallet, f.status].map((x) => x ?? "-").join("|");

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? new Date(v).toISOString() : null);

// The newest block at or before the scrubber minute (or the newest block when live). Windows end there, so a
// scrubbed view never claims data after its time.
export async function anchorAt(db: Db, at: string | null): Promise<Date | null> {
  const query = at
    ? sql`SELECT ts FROM blocks WHERE ts < ${new Date(isoMinuteDate(at).getTime() + 60_000)} ORDER BY ts DESC LIMIT 1`
    : sql`SELECT ts FROM blocks ORDER BY ts DESC LIMIT 1`;
  const [row] = (await db.execute(query)).rows as Row[];
  const ts = iso(row?.ts);
  return ts ? new Date(ts) : null;
}

// First and newest ingested block, the scrubber's track.
export async function coverage(db: Db): Promise<{ first: string | null; last: string | null }> {
  const [row] = (await db.execute(sql`SELECT (SELECT ts FROM blocks ORDER BY ts LIMIT 1) AS first, (SELECT ts FROM blocks ORDER BY ts DESC LIMIT 1) AS last`)).rows as Row[];
  return { first: iso(row?.first), last: iso(row?.last) };
}

// PROJECT.md 23 `SUBSIDY_END_DATE` (default 2026-09-29). "After" starts at 00:00 UTC of that day, as in the prototype.
export function subsidyEnd(): string {
  const v = process.env.SUBSIDY_END_DATE ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ? v : "2026-09-29";
  return `${day}T00:00:00.000Z`;
}
