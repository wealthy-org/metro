// The advice and accusation filter (PROJECT.md 13.3 limits, rules.md 2; Phase 10 AT 18): a model output that gives
// financial advice, predicts prices, or makes an identity or intent claim is rejected exactly like a failed number
// check, and the ladder retries or falls to the Template. Wording stays factual: shares and counts only.

const ADVICE = /\b(buy|buying|sell|selling|invest(?:ing|ment)?|should\s+(?:buy|sell|invest|hold)|recommend(?:ed|ation)?|price\s+target|target\s+price|predict(?:ed|ion)?|forecast|guarantee(?:d|s)?|profit|profitab\w*|undervalued|overvalued|bullish|bearish)\b/i;
const IDENTITY = /\b(sybil|bot|bots|fraud(?:ulent)?|scam|insider|manipulat\w*|criminal|launder\w*)\b/i;

export function adviceIssue(text: string): string | null {
  const a = ADVICE.exec(text);
  if (a) return `advice or prediction wording ("${a[0]}")`;
  const i = IDENTITY.exec(text);
  if (i) return `an identity or intent claim ("${i[0]}")`;
  return null;
}
