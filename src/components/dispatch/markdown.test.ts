import { describe, expect, it } from "vitest";
import { parseMarkdown, safeHref, safeSvg } from "./Markdown.tsx";

// Report Markdown safety (Phase 11 gate F81): only the SVG Metro draws reaches innerHTML, and only internal links
// render as links.

describe("safeSvg", () => {
  it("accepts the single svg element this project writes", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240" width="100%"><rect width="640" height="240" fill="#0b0d12"/></svg>`;
    expect(safeSvg(svg)).toBe(svg);
  });

  it("rejects anything that is not one plain svg", () => {
    expect(safeSvg(`<img src=x onerror="alert(1)">`)).toBeNull();
    expect(safeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)).toBeNull();
    expect(safeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"></body></foreignObject></svg>`)).toBeNull();
    expect(safeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x()"/></svg>`)).toBeNull();
    expect(safeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,x"/></svg>`)).toBeNull();
    expect(safeSvg(`<div>text</div>`)).toBeNull();
  });
});

describe("parseMarkdown", () => {
  it("keeps a safe fence as a svg block and renders an unsafe one as text", () => {
    const ok = parseMarkdown("```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>\n```");
    expect(ok).toEqual([{ type: "svg", lines: [`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`] }]);
    const bad = parseMarkdown("```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"><script>x</script></svg>\n```");
    expect(bad[0]?.type).toBe("pre");
    expect(bad[0]?.lines[0]).toContain("<script>");
  });

  it("reads headings, lists and paragraphs", () => {
    const blocks = parseMarkdown("# Title\n\n## Summary\n\nOne line.\n\n- a\n- b\n\n1. first\n2. second\n");
    expect(blocks.map((b) => b.type)).toEqual(["h1", "h2", "p", "ul", "ol"]);
    expect(blocks[3]?.lines).toEqual(["a", "b"]);
  });
});

describe("safeHref", () => {
  it("allows internal paths only", () => {
    expect(safeHref("/lens/city?window=24h&at=2026-09-28T23:59Z")).toBe("/lens/city?window=24h&at=2026-09-28T23:59Z");
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://evil.example")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
  });
});
