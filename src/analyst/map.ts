import { MAP_SYSTEM, ANALYST_MODELS } from "../../config/analyst-models.ts";
import { spendCall } from "./budget.ts";
import { chat, ModelError } from "./openrouter.ts";
import { isCityWindow } from "../lib/city.ts";
import { ACTION_KEYS, extractAddress, isTopicKey, matchRefusal, matchTopic, normalizeScope, TOPICS, type Scope, type TopicKey } from "./topics.ts";

// Free text to a limited choice (PROJECT.md 13.3 step 1; Phase 10 D2): keyword rules first, which cost nothing; when
// they find nothing, one model call returns JSON that code validates against the lists. Invalid JSON, invalid values or
// "none" all end as a refusal with its reason. The walk touches only one 0x address: the one the topic needs.

export type Mapping = { kind: "topic"; topic: TopicKey; scope: Scope; trail: string[] } | { kind: "refused"; reason: string; trail: string[] } | { kind: "unclear"; trail: string[] };

const OUTSIDE = "That is outside the topics Surveyor answers. It explains fees, activity, holders, the subsidy and the Ledger of Facts; the full topic list is on /methodology.";

// The slots a topic needs are filled from the question when the view state does not carry them already.
function fillSlots(topic: TopicKey, base: Scope, question: string): Scope {
  const needs = TOPICS[topic].needs;
  if (!needs.length) return base;
  const found = extractAddress(question);
  return {
    ...base,
    token: base.token ?? (needs.includes("token") ? found : null),
    address: base.address ?? (needs.includes("address") ? found : null),
  };
}

type ParsedMapping = { topic: TopicKey | "none"; scope: Scope };

// The classifier's answer: JSON only, fenced or not; anything else is unusable.
export function parseMapping(text: string, base: Scope): ParsedMapping | null {
  const body = text.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const topic = typeof raw.topic === "string" ? raw.topic : "";
  if (topic === "none") return { topic: "none", scope: base };
  if (!isTopicKey(topic)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() && v !== "null" ? v.trim() : undefined);
  // A value outside the lists makes the whole answer unusable; nothing is silently dropped (PROJECT.md 19).
  const window = str(raw.window);
  if (window !== undefined && !isCityWindow(window)) return null;
  const action = str(raw.action);
  if (action !== undefined && !(ACTION_KEYS as string[]).includes(action)) return null;
  const scope = normalizeScope({
    window: window ?? base.window,
    action: action ?? base.action ?? undefined,
    token: str(raw.token) ?? base.token ?? undefined,
    address: str(raw.address) ?? base.address ?? undefined,
  });
  return { topic, scope: fillSlots(topic, scope, "") };
}

export async function mapQuestion(question: string, base: Scope, available: string[] | null): Promise<Mapping> {
  const trail: string[] = [];
  // A refusal wins over a topic keyword: "Should I buy when swaps are cheapest?" is advice, not a fee question.
  const refused = matchRefusal(question);
  if (refused) {
    trail.push("Refused from keywords; no model call.");
    return { kind: "refused", reason: refused, trail };
  }
  const keyword = matchTopic(question);
  if (keyword) {
    trail.push(`Topic "${TOPICS[keyword].title}" matched from keywords; no model call.`);
    const scope = fillSlots(keyword, base, question);
    if (TOPICS[keyword].needs.includes("token") && !scope.token) return { kind: "refused", reason: "This topic needs a token: open a token page or name a 0x token address in the question.", trail };
    if (TOPICS[keyword].needs.includes("address") && !scope.address) return { kind: "refused", reason: "This topic needs an address: open a wallet page or name a 0x address in the question.", trail };
    return { kind: "topic", topic: keyword, scope, trail };
  }
  // One classification call, in ladder order, until a usable answer comes back (PROJECT.md 13.3 step 1).
  for (const layer of ANALYST_MODELS) {
    if (available && !available.includes(layer.model) && layer.model !== "openrouter/free") {
      trail.push(`${layer.name} skipped for classification: not on the model list.`);
      continue;
    }
    const budget = await spendCall();
    if (!budget.ok) {
      trail.push(`Classification stopped: the model budget for this ${budget.reason === "day" ? "day" : "minute"} is spent.`);
      return { kind: "unclear", trail };
    }
    try {
      const { text } = await chat(layer.model, [{ role: "system", content: MAP_SYSTEM }, { role: "user", content: question }], { maxTokens: 150, temperature: 0 });
      const parsed = parseMapping(text, base);
      if (parsed === null) {
        trail.push(`${layer.name}: the classification was not usable; next layer.`);
        continue;
      }
      if (parsed.topic === "none") {
        trail.push(`${layer.name} placed the question outside the topics.`);
        return { kind: "refused", reason: OUTSIDE, trail };
      }
      trail.push(`${layer.name} classified the question as "${TOPICS[parsed.topic].title}".`);
      const scope = fillSlots(parsed.topic, parsed.scope, question);
      if (TOPICS[parsed.topic].needs.includes("token") && !scope.token) return { kind: "refused", reason: "This topic needs a token: open a token page or name a 0x token address in the question.", trail };
      if (TOPICS[parsed.topic].needs.includes("address") && !scope.address) return { kind: "refused", reason: "This topic needs an address: open a wallet page or name a 0x address in the question.", trail };
      return { kind: "topic", topic: parsed.topic, scope, trail };
    } catch (err) {
      trail.push(`${layer.name}: ${err instanceof ModelError ? err.failure : "failed"} during classification; next layer.`);
    }
  }
  return { kind: "unclear", trail };
}
