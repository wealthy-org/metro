// The numeric validator (PROJECT.md 13.3 step 4; Phase 10 D4). Every number a model writes must either equal a fact
// value rounded to the digits written, after the stated unit conversions (%, K, M, B), or be part of the question's
// context: a sample size, a window length, or a date or hour that appears in the facts block. Anything else rejects
// the answer, and the ladder retries or falls to the Template. The rule is stated on /methodology.

export type FactValue = { key: string; value: number; n: number };

export type NumberContext = {
  facts: FactValue[];
  // Context numbers: parts of the windows and their lengths, plus any total the facts block states.
  numbers: number[];
  // "HH:MM" labels the facts block uses (windows are whole hours), allowed verbatim.
  times: string[];
};

type Written = { raw: string; value: number; decimals: number; scale: number };

// Times first: "06:00" must not be eaten by the number pattern as "06".
const TOKEN = /\b\d{1,2}:\d{2}\b|\$?\d[\d,]*(?:\.\d+)?(?:\s?%|[KMB]\b)?/g;
const ADDRESS = /0x[0-9a-f]{4,}/gi;

function parseToken(raw: string): Written | { time: string } | null {
  const time = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (time) {
    const [, h = "0", min = "00"] = time;
    return { time: `${h.padStart(2, "0")}:${min}` };
  }
  const percent = raw.trimEnd().endsWith("%");
  const body = raw.replace(/[$,\s%]/g, "");
  const m = /^(\d+(?:\.\d+)?)([KMB]?)$/.exec(body);
  if (!m) return null;
  const value = Number.parseFloat(m[1] ?? "");
  if (!Number.isFinite(value)) return null;
  const decimals = (m[1]?.split(".")[1] ?? "").length;
  const unit = m[2] ?? "";
  // The scale brings the written number into the fact's own units: 99.95% → × 0.01, 13.3M → × 1e6. The rounding
  // tolerance is half a step of the last digit written, in those same units.
  const scale = percent ? 0.01 : unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : 1;
  return { raw, value, decimals, scale };
}

// Candidates the answer may use: every fact value and sample size, each also at hundred, thousand, million and billion
// scale, plus the context numbers. The comparison rounds at the digits the answer wrote.
export function numberContext(facts: FactValue[], numbers: number[] = [], times: string[] = []): NumberContext {
  return { facts, numbers, times };
}

export function checkNumbers(text: string, ctx: NumberContext): { ok: boolean; bad: string[] } {
  const clean = text.replace(ADDRESS, "0xaddr");
  const candidates: number[] = [];
  const add = (v: number, scale: number) => {
    if (Number.isFinite(v)) candidates.push(v * scale);
  };
  for (const f of ctx.facts) {
    for (const scale of [1, 100, 1e-3, 1e-6, 1e-9]) add(f.value, scale);
    for (const scale of [1, 1e-3, 1e-6]) add(f.n, scale);
  }
  for (const n of ctx.numbers) add(n, 1);
  const times = new Set(ctx.times);
  const bad: string[] = [];
  for (const match of clean.matchAll(TOKEN)) {
    const raw = match[0];
    const parsed = parseToken(raw);
    if (!parsed) continue;
    if ("time" in parsed) {
      if (!times.has(parsed.time)) bad.push(raw);
      continue;
    }
    // In the fact's units, the written value rounds at (0.5 × 10^-decimals × scale).
    const target = parsed.value * parsed.scale;
    const tolerance = 0.5 * 10 ** -parsed.decimals * parsed.scale;
    const ok = candidates.some((c) => Math.abs(c - target) <= tolerance + 1e-9 * (1 + Math.abs(c)));
    if (!ok) bad.push(raw);
  }
  return { ok: bad.length === 0, bad };
}
