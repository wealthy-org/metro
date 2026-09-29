import type { ReactNode } from "react";

// Renders the report Markdown (PROJECT.md 14.3; Phase 11). It parses only the subset Dispatch writes: headings,
// paragraphs, bullet and numbered lists, inline links, and `svg` fences holding markup we generated server-side from
// facts. No other HTML passes through, and everything outside a link or an svg fence is rendered as text.

type Block = { type: "h1" | "h2" | "p" | "ul" | "ol" | "svg" | "pre"; lines: string[] };

// Only the SVG this project draws itself may reach dangerouslySetInnerHTML: one <svg> element, no script, no foreign
// content, no event handlers, no external references. Anything else (a fence the model wrote, for instance) renders as
// plain text.
export function safeSvg(content: string): string | null {
  const t = content.trim();
  if (!/^<svg[\s>]/.test(t) || !/<\/svg>$/.test(t)) return null;
  if (/<script|<style|<foreignObject|<iframe|<object|<embed|<image|<use|<a[\s>]|on[a-z]+\s*=|javascript:|data:|xlink:href/i.test(t)) return null;
  return t;
}

// Report links are internal paths Metro builds; anything else renders as text.
export function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}

export function parseMarkdown(body: string): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```svg")) {
      const svg: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        svg.push(lines[i] ?? "");
        i++;
      }
      i++;
      const content = svg.join("\n");
      blocks.push(safeSvg(content) === null ? { type: "pre", lines: [content] } : { type: "svg", lines: [content] });
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", lines: [line.slice(3)] });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", lines: [line.slice(2)] });
      i++;
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
        items.push((lines[i] ?? "").slice(2));
        i++;
      }
      blocks.push({ type: "ul", lines: items });
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\. /, ""));
        i++;
      }
      blocks.push({ type: "ol", lines: items });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#|##|```svg|- |\d+\. )/.test(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ type: "p", lines: [para.join(" ")] });
  }
  return blocks;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const href = safeHref(m[2] ?? "");
    if (href === null) {
      out.push(m[0]);
    } else {
      out.push(
        <a key={`${at}-${href}`} href={href} className="text-text underline decoration-mute underline-offset-2 hover:decoration-text">
          {m[1] ?? ""}
        </a>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ body }: { body: string }) {
  const blocks = parseMarkdown(body);
  return (
    <article className="dispatch-report max-w-[92ch] text-[14px] leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === "h1") return <h1 key={i} className="mt-1 mb-3 font-display text-[30px] font-bold tracking-[0.01em]">{b.lines[0]}</h1>;
        if (b.type === "h2") return <h2 key={i} className="mt-7 mb-2 font-display text-[20px] font-bold tracking-[0.01em]">{b.lines[0]}</h2>;
        if (b.type === "ul")
          return (
            <ul key={i} className="my-2 list-disc space-y-1 pl-5">
              {b.lines.map((l, k) => (
                <li key={k}>{inline(l)}</li>
              ))}
            </ul>
          );
        if (b.type === "ol")
          return (
            <ol key={i} className="my-2 list-decimal space-y-1 pl-5">
              {b.lines.map((l, k) => (
                <li key={k}>{inline(l)}</li>
              ))}
            </ol>
          );
        if (b.type === "svg") return <div key={i} className="my-3 overflow-hidden rounded-[3px] border border-line bg-bg" dangerouslySetInnerHTML={{ __html: b.lines[0] ?? "" }} />;
        if (b.type === "pre")
          return (
            <pre key={i} className="my-3 overflow-auto rounded-[3px] border border-line bg-bg p-3 font-mono text-[11px] whitespace-pre-wrap text-mute">
              {b.lines[0]}
            </pre>
          );
        return (
          <p key={i} className="my-2">
            {inline(b.lines[0] ?? "")}
          </p>
        );
      })}
    </article>
  );
}
