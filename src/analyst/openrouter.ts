// One chat call to OpenRouter (PROJECT.md 13.4; Phase 10). Technical failures are classified so the ladder can decide
// whether to retry, wait or step down (13.4.1): a rate limit, a server error, a timeout, a network failure or a model
// that cannot answer. A missing key is fatal for the whole ladder and leads straight to the Template.

export type ChatMessage = { role: "system" | "user"; content: string };
export type ChatFailure = "no_key" | "rate_limit" | "server" | "timeout" | "network" | "unavailable";

export class ModelError extends Error {
  readonly failure: ChatFailure;
  readonly status: number | undefined;
  constructor(failure: ChatFailure, message: string, status?: number) {
    super(message);
    this.name = "ModelError";
    this.failure = failure;
    this.status = status;
  }
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export async function chat(model: string, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {}): Promise<{ text: string; model: string }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new ModelError("no_key", "OPENROUTER_API_KEY is not set");
  const timeoutMs = opts.timeoutMs ?? 45_000;
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 400,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") throw new ModelError("timeout", `no answer within ${timeoutMs} ms`);
    throw new ModelError("network", "the model endpoint could not be reached");
  }
  if (res.status === 429) throw new ModelError("rate_limit", "the model endpoint rate limited the call", 429);
  if (res.status >= 500) throw new ModelError("server", `the model endpoint failed with ${res.status}`, res.status);
  if (!res.ok) throw new ModelError("unavailable", `the model refused the call (${res.status})`, res.status);
  let json: { model?: string; choices?: { message?: { content?: string | null } }[] };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new ModelError("unavailable", "the model returned a body that is not JSON");
  }
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new ModelError("unavailable", "the model returned no text");
  return { text, model: json.model || model };
}

// The model list, for the daily cron (PROJECT.md 13.4.5): every model OpenRouter offers, with its price, so the cron
// can keep the free ones that still exist. No key needed for this read.
export async function listModels(): Promise<{ id: string; free: boolean }[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ModelError("unavailable", `the model list failed with ${res.status}`, res.status);
  const json = (await res.json()) as { data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[] };
  return (json.data ?? [])
    .filter((m): m is { id: string; pricing?: { prompt?: string; completion?: string } } => typeof m.id === "string")
    .map((m) => ({ id: m.id, free: m.pricing?.prompt === "0" && m.pricing?.completion === "0" }));
}
