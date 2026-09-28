import Link from "next/link";
import type { ReactNode } from "react";
import { formatMetric } from "../../lib/city.ts";
import { NA, shortHex, utcMinute } from "../../lib/format.ts";
import { NarrowGuard } from "../layout/NarrowGuard.tsx";
import { Ticker } from "../layout/Ticker.tsx";

// Shared frame and parts for /token, /wallet and /tx (PROJECT.md 7, 15): the Ticker across the top and one scrolling
// column in the workspace's dark style. Tables follow the prototype's Launchpad table (lines 127-134).

export const int = new Intl.NumberFormat("en-US");
// The shared formatters under the short names the profile pages use (gate F37).
export const short = shortHex;
export const utc = utcMinute;
export const usd = (v: number | null) => formatMetric(v, "avg_fee_usd");
export const pct = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);

export function ProfileShell({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <>
      <NarrowGuard />
      <div className="grid h-screen grid-rows-[56px_1fr] overflow-hidden max-[1279px]:hidden">
        <Ticker />
        <main className="min-h-0 overflow-auto bg-bg">
          <div className="mx-auto max-w-[1120px] px-[22px] py-[18px]">
            <nav aria-label="Breadcrumb" className="mb-3 text-[12px] text-mute">
              <Link href="/lens/city" className="text-mute underline decoration-mute underline-offset-2 hover:text-text">
                Metro
              </Link>
              <span className="mx-1.5">/</span>
              <span>{kind}</span>
            </nav>
            {children}
          </div>
        </main>
      </div>
    </>
  );
}

export function NotFound({ kind, text }: { kind: string; text: string }) {
  return (
    <ProfileShell kind={kind}>
      <h1 className="font-display text-[34px] leading-none font-bold">Not found</h1>
      <p className="mt-3 max-w-[60ch] text-[15px] text-mute">{text}</p>
      <p className="mt-4 text-[14px]">
        <A href="/lens/flow">Open the live Flow</A> or <A href="/lens/launchpad">the Launchpad</A>.
      </p>
    </ProfileShell>
  );
}

export function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-1 font-display text-[18px] font-bold tracking-[0.01em]">{title}</h2>
      {note ? <p className="mb-2 max-w-[92ch] text-[12px] text-mute">{note}</p> : null}
      {children}
    </section>
  );
}

// Label and value pairs, four to a row, like the Inspector's figures.
export function Facts({ items }: { items: { label: string; value: ReactNode; title?: string }[] }) {
  return (
    <dl className="grid grid-cols-4 gap-px overflow-hidden rounded-[3px] border border-line bg-line">
      {items.map((f) => (
        <div key={f.label} className="bg-panel px-3 py-2.5" title={f.title}>
          <dt className="text-[10px] tracking-[0.08em] text-mute uppercase">{f.label}</dt>
          <dd className="mt-1 truncate font-mono text-[14px]">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="text-[12px] text-mute">{empty}</p>;
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" className={`border-b border-line px-1.5 py-1.5 text-[10px] font-medium tracking-[0.08em] text-mute uppercase ${i === 0 ? "text-left" : "text-right"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-panel2">
            {r.map((c, j) => (
              <td key={j} className={`border-b border-line px-1.5 py-[7px] font-mono ${j === 0 ? "text-left" : "text-right"}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// In-app link for an address, transaction or token, underlined like the Launchpad token cell.
export function A({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <Link href={href} prefetch={false} title={title} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
      {children}
    </Link>
  );
}

export function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-mute underline decoration-mute underline-offset-2 hover:text-text">
      {children}
    </a>
  );
}

// Vertical bars for a short series (daily counts, hours of the day); the value is in each bar's title.
export function Bars({ values, labels, format, color = "#c8f04a" }: { values: (number | null)[]; labels: string[]; format: (v: number) => string; color?: string }) {
  const max = Math.max(1e-12, ...values.map((v) => v ?? 0));
  return (
    <div className="flex h-[96px] items-end gap-[3px]" role="img" aria-label={values.map((v, i) => `${labels[i]}: ${v === null ? "no data" : format(v)}`).join(", ")}>
      {values.map((v, i) => (
        <div key={labels[i]} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${labels[i]}: ${v === null ? "no data" : format(v)}`}>
          <div className="w-full rounded-t-[2px]" style={{ height: `${v ? Math.max(2, (v / max) * 72) : 1}px`, background: v ? color : "#242a36" }} />
          <span className="font-mono text-[9px] text-mute">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}
