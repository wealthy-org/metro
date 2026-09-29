import { createServer } from "node:http";

// A stand-in for OpenRouter for the end-to-end suite (Phase 13; the plan's "mocked OpenRouter"). It answers chat
// completions with a neutral sentence that carries no digits, so the Phase 10 numeric validator passes without any
// real model call, and it serves a models list for the model-check path.
const PORT = 4319;

const MODELS = {
  data: [
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Mock Nemotron" },
    { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Mock Llama" },
    { id: "google/gemma-3-27b-it:free", name: "Mock Gemma" },
    { id: "qwen/qwen3-235b-a22b:free", name: "Mock Qwen" },
    { id: "cohere/north-mini-code:free", name: "Mock Cohere" },
    { id: "mistralai/mistral-small-3.2-24b-instruct:free", name: "Mock Mistral" },
  ],
};

const ANSWER = "The stored facts state the window and its sample; the figures reported above are taken from them unchanged.";

export default async function globalSetup() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/api/v1/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mock/model", choices: [{ message: { role: "assistant", content: ANSWER } }], usage: {} }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(MODELS));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
