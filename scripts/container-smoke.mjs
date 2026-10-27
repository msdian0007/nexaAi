import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const apiBase = process.env.SMOKE_API_BASE_URL ?? "http://127.0.0.1:5000/api/v1";
const frontendBase = process.env.SMOKE_FRONTEND_BASE_URL ?? "http://127.0.0.1:8080";

async function response(path, options = {}) {
  return fetch(`${apiBase}${path}`, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
}

async function json(path, expectedStatus, options = {}) {
  const result = await response(path, options);
  const body = await result.json();
  assert.equal(result.status, expectedStatus, `${path} returned ${result.status}: ${JSON.stringify(body)}`);
  return body.data;
}

// These checks prove that the API process can reach PostgreSQL and Redis.
for (const path of ["/health/live", "/health/ready"]) {
  const result = await response(path);
  assert.equal(result.status, 200, `${path} returned ${result.status}`);
}

// A nested URL must return the SPA entry page, not an Nginx 404.
const frontend = await fetch(`${frontendBase}/documents`, { signal: AbortSignal.timeout(15_000) });
assert.equal(frontend.status, 200, `frontend route returned ${frontend.status}`);
assert.match(await frontend.text(), /<div id="root"><\/div>/, "frontend did not return the NexaAI SPA");

const runId = randomUUID();
const account = await json("/auth/register", 201, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Container Smoke Test",
    email: `${runId}@example.invalid`,
    password: `Smoke-${runId}`,
    organizationName: `Container Smoke ${runId}`,
  }),
});
assert.equal(typeof account.token, "string", "registration did not return a token");

// The API writes this file to the shared upload volume. The separate worker must
// read it, create local embeddings, and save READY in PostgreSQL.
const form = new FormData();
form.append("document", new Blob([
  "Fictional container handbook. Employees receive eighteen annual leave days.",
], { type: "text/plain" }), "container-handbook.txt");
const uploaded = await json("/documents/upload", 202, {
  method: "POST",
  headers: { Authorization: `Bearer ${account.token}` },
  body: form,
});

const deadline = Date.now() + 180_000;
let document;
do {
  await new Promise(resolve => setTimeout(resolve, 2_000));
  document = await json(`/documents/${uploaded.id}/status`, 200, {
    headers: { Authorization: `Bearer ${account.token}` },
  });
  if (document.processingState === "FAILED") throw new Error("worker reported FAILED");
} while (document.processingState !== "READY" && Date.now() < deadline);

assert.equal(document.processingState, "READY", `worker did not finish; state=${document.processingState}`);
console.log("Container smoke passed: frontend, API, PostgreSQL, Redis, shared upload, and worker are connected.");
