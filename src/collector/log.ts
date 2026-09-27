type Level = "info" | "warn" | "error";

// One JSON object per line so Railway and other log sinks can parse fields (PROJECT.md 19, observability).
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (level === "error") console.error(line);
  else console.log(line);
}
