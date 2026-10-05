// Explicit live diagnostic. Only fictional input; never prints credentials or headers.
require("dotenv/config");
const { createGeminiGenerator, DEFAULT_GEMINI_MODEL } = require("../dist/src/rag/gemini.provider");
const key = process.env.GEMINI_API_KEY?.trim();
const model = process.argv[2] || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const sanitize = value => String(value ?? "").split(key || "NO_KEY").join("[REDACTED]").replace(/AIza[\w-]+/g, "[REDACTED]").slice(0, 1200);
async function inspect(response, label) {
  const body = await response.clone().json().catch(() => ({}));
  console.log(JSON.stringify({ label, httpStatus: response.status, status: body.error?.status,
    message: sanitize(body.error?.message), ...(label === "models" ? {
      models: body.models?.filter(m => m.supportedGenerationMethods?.includes("generateContent")).map(m => m.name),
    } : {}) }));
  return response;
}
async function main() {
  if (!key) throw new Error("Key missing");
  if (!/^gemini-[a-z0-9.-]+$/.test(model)) throw new Error("Invalid model");
  console.log(JSON.stringify({ configuredModel: model }));
  await inspect(await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(30000),
  }), "models");
  const generate = createGeminiGenerator({ model, fetchImpl: async (url, init) => inspect(await fetch(url, init), "generation") });
  const answer = await generate([
    { role: "system", content: 'Return JSON with status "answered", answer "18 days [S1].", and citations ["S1"].' },
    { role: "user", content: "Fictional policy S1: annual leave is 18 days. How much annual leave?" },
  ]);
  console.log(JSON.stringify({ generated: true, answer: sanitize(answer) }));
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || "DIAGNOSTIC_FAILED" })); process.exitCode = 1; });
