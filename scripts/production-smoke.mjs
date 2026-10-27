import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const publicBase = (process.env.SMOKE_BASE_URL ?? "").replace(/\/$/, "");
if (!publicBase) throw new Error("Set SMOKE_BASE_URL to the deployed public origin.");
if (!publicBase.startsWith("https://") && process.env.SMOKE_ALLOW_HTTP !== "true")
  throw new Error("Production smoke verification requires an HTTPS origin.");
const apiBase = `${publicBase}/api/v1`;

async function call(path, expectedStatus, options = {}, timeout = 20_000) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body.data;
}

for (const endpoint of ["/health/live", "/health/ready"]) await call(endpoint, 200);
const nested = await fetch(`${publicBase}/documents`, { signal: AbortSignal.timeout(20_000) });
assert.equal(nested.status, 200, "SPA route fallback failed");
assert.match(await nested.text(), /<div id="root"><\/div>/, "deployed response is not the NexaAI frontend");

async function register(label) {
  const id = randomUUID();
  return call("/auth/register", 201, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `${label} production verifier`,
      email: `production-smoke-${id}@example.invalid`,
      password: `Smoke-${id}`,
      organizationName: `${label} smoke ${id}`,
    }),
  });
}

// Two isolated workspaces prove that knowing a document ID does not grant access.
const owner = await register("Primary");
const outsider = await register("Isolated");
const authorized = token => ({ Authorization: `Bearer ${token}` });

const handbookText = [
  "NexaAI production verification handbook.",
  "Full-time employees receive eighteen days of paid annual leave per calendar year.",
  "Leave requests must be approved by a manager.",
].join("\n");
const form = new FormData();
form.append("document", new Blob([handbookText], { type: "text/plain" }), "production-verification-handbook.txt");
const document = await call("/documents/upload", 202, {
  method: "POST",
  headers: authorized(owner.token),
  body: form,
}, 30_000);

const deadline = Date.now() + 180_000;
let status;
do {
  await new Promise(resolve => setTimeout(resolve, 2_000));
  status = await call(`/documents/${document.id}/status`, 200, { headers: authorized(owner.token) });
  if (status.processingState === "FAILED") throw new Error("Background document processing failed");
} while (status.processingState !== "READY" && Date.now() < deadline);
assert.equal(status.processingState, "READY", `worker did not finish; state=${status.processingState}`);

await call(`/documents/${document.id}/status`, 404, { headers: authorized(outsider.token) });
const answer = await call("/chat/query", 200, {
  method: "POST",
  headers: { ...authorized(owner.token), "Content-Type": "application/json" },
  body: JSON.stringify({
    question: "How many paid annual leave days do full-time employees receive?",
    minSimilarity: 0,
  }),
}, 90_000);
assert.equal(answer.status, "answered");
assert.match(answer.answer, /\b(?:18|eighteen)\b/i);
assert.ok(answer.citations.length > 0, "answer has no citations");
assert.ok(answer.sources.some(source => source.documentId === document.id && answer.citations.includes(source.sourceId)));

const history = await call(`/chat/conversations/${answer.conversationId}/messages`, 200, {
  headers: authorized(owner.token),
});
assert.deepEqual(history.messages.map(message => message.content), [
  "How many paid annual leave days do full-time employees receive?",
  answer.answer,
]);
await call(`/chat/conversations/${answer.conversationId}/messages`, 404, {
  headers: authorized(outsider.token),
});

console.log(JSON.stringify({
  success: true,
  checked: ["https", "spa", "database", "redis", "object-storage", "worker", "gemini", "history", "tenant-isolation"],
  documentId: document.id,
  conversationId: answer.conversationId,
}));
