import type { InsightT } from "../../lib/api-types.ts";
import { utcMinute } from "../../lib/format.ts";

// One insight as in the prototype's Insights pane (.ins, lines 141-146 and renderInsights): rule and severity on
// top, the template text, `n` and the window, and the evidence link (PROJECT.md 13.2, AT 15/16). "Not enough data"
// rows are dimmed like the prototype's `.ins.low`, with a muted text color instead of opacity, so every line keeps
// at least 4.5:1 (gate F44: opacity 0.75 took the muted lines to 4.01:1). The evidence is a full navigation, so the
// lens reads the view from its URL.

const int = new Intl.NumberFormat("en-US");

function windowText(i: InsightT): string {
  const { start, end } = i.window;
  if (!start || !end) return "";
  const a = utcMinute(start);
  const b = utcMinute(end);
  return a.slice(0, 10) === b.slice(0, 10) ? `${a.slice(0, 16)} to ${b.slice(11)}` : `${a.slice(0, 16)} to ${b}`;
}

export function InsightCard({ insight: i, compact = false }: { insight: InsightT; compact?: boolean }) {
  const low = i.status === "not_enough_data";
  return (
    <article className="mb-2.5 rounded-[3px] border border-line bg-panel2 p-3" aria-label={`${i.title}: ${low ? "not enough data" : i.severity}`}>
      <div className="mb-1.5 flex justify-between gap-2 text-[10px] tracking-[0.08em] text-mute uppercase">
        <span>{i.title}</span>
        <b className={`font-medium ${low ? "text-mute" : i.severity === "attention" ? "text-c1" : "text-text"}`}>{low ? "Not enough data" : i.severity === "attention" ? "Attention" : "Info"}</b>
      </div>
      <p className={`mb-2 ${compact ? "text-[13px]" : "text-[14px]"} leading-[1.45] ${low ? "text-mute" : ""}`}>{i.text}</p>
      <div className="mb-2 font-mono text-[11px] text-mute">
        n = {int.format(i.n)}
        {windowText(i) ? ` · ${windowText(i)}` : ""}
      </div>
      <a href={i.evidence_url} className="inline-block rounded-[3px] border border-line bg-panel px-[11px] py-[5px] text-[12px] text-text no-underline hover:border-mute">
        {low ? "Open the view" : "Show the evidence"}
      </a>
    </article>
  );
}
