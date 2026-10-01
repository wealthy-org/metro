// One swap point for the landing wordmark and every Ticker mark.
// When the logo arrives, replace the text here and update `src/app/icon.svg`; lens rail labels remain lens names.

export function BrandMark({ mark = false, className = "" }: { mark?: boolean; className?: string }) {
  return <span className={className}>{mark ? "M" : "METRO"}</span>;
}
