// Real authentication, local embeddings and PostgreSQL; Gemini is replaced with a controlled reply.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;
const { generateEmbedding } = require("../dist/src/document/document.embedding");
const provider = require("../dist/src/rag/gemini.provider");
const router = require("../dist/src/rag/rag.routes").default;
const originalGenerator = provider.generateGeminiText;
const originalSecret = process.env.JWT_SECRET;
const tenants = [];
const question = "How much paid time off do employees get?";
let server, url, token, emptyToken, ownChunk, calls = 0, reply;

async function tenant(content) {
  const id = randomUUID();
  await prisma.user.create({ data: {
    id, name: "RAG test", email: `${id}@example.invalid`, password: "unused",
    memberships: { create: { role: "MEMBER", organization: { create: { id, name: "RAG test", slug: `rag-test-${id}` } } } },
  } });
  tenants.push(id);
  if (content) {
    const doc = await prisma.document.create({ data: {
      organizationId: id, uploadedById: id, name: "test", originalName: "handbook.txt",
      mimeType: "text/plain", size: content.length, storagePath: "unused", status: "COMPLETED",
      chunks: { create: { chunkIndex: 0, content, embeddingStatus: "COMPLETED" } },
    }, include: { chunks: true } });
    const chunk = doc.chunks[0];
    const vector = `[${(await generateEmbedding(content)).join(",")}]`;
    await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vector}::vector(384) WHERE id = ${chunk.id}`;
    if (!ownChunk) ownChunk = chunk;
  }
  return jwt.sign({ userId: id, organizationId: id, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "5m" });
}

before(async () => {
  process.env.JWT_SECRET = randomUUID();
  token = await tenant("Employees receive eighteen days of paid annual leave each year.");
  await tenant("Employees receive ninety days of paid annual leave each year. OTHER_TENANT_ONLY");
  emptyToken = await tenant();
  provider.generateGeminiText = async messages => { calls++; return reply(messages); };
  const app = express();
  app.use(express.json());
  app.use("/api/v1/chat", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/v1/chat/query`;
});

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    for (const id of tenants) await prisma.$transaction([
      prisma.document.deleteMany({ where: { organizationId: id } }),
      prisma.organization.delete({ where: { id } }),
      prisma.user.delete({ where: { id } }),
    ]);
  } finally {
    provider.generateGeminiText = originalGenerator;
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    await prisma.$disconnect();
  }
});

async function query(body, auth = token) {
  const response = await fetch(url, { method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}

test("answers using only the signed tenant's evidence and server-owned source metadata", async () => {
  reply = messages => {
    const input = JSON.parse(messages.find(m => m.role === "user").content);
    assert.equal(input.question, question);
    assert.deepEqual(input.evidence, [{ sourceId: "S1", content: ownChunk.content }]);
    return JSON.stringify({ status: "answered", answer: "Employees receive 18 days [S1].", citations: ["S1"] });
  };
  const previous = calls;
  const result = await query({ question: ` ${question} `, organizationId: tenants[1] });
  assert.equal(result.status, 200);
  assert.equal(calls, previous + 1);
  assert.equal(result.body.data.question, question);
  assert.equal(result.body.data.status, "answered");
  assert.deepEqual(result.body.data.citations, ["S1"]);
  assert.equal(result.body.data.sources.length, 1);
  assert.equal(result.body.data.sources[0].chunkId, ownChunk.id);
  assert.equal(result.body.data.sources[0].documentId, ownChunk.documentId);
  assert.equal(result.body.data.sources[0].documentName, "handbook.txt");
  assert.equal(result.body.data.sources[0].content, undefined);
});

test("empty and irrelevant evidence return insufficient information without Gemini", async () => {
  const previous = calls;
  for (const [body, auth] of [
    [{ question }, emptyToken],
    [{ question: "How far is Jupiter from the sun?" }, token],
    [{ question, minSimilarity: 0.99 }, token],
  ]) {
    const result = await query(body, auth);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.status, "insufficient_information");
    assert.deepEqual(result.body.data.citations, []);
    assert.deepEqual(result.body.data.sources, []);
  }
  assert.equal(calls, previous);
});

test("validates input and requires signed organization context before generation", async () => {
  const previous = calls;
  for (const body of [{}, { question: " " }, { question: 42 }, { question: "x".repeat(1001) },
    ...[0, 11, 1.5, "3", null].map(topK => ({ question, topK })),
    ...[-1, 2, "0.35", null, true].map(minSimilarity => ({ question, minSimilarity }))]) {
    assert.equal((await query(body)).status, 400);
  }
  for (const auth of [null, "invalid", jwt.sign({ userId: tenants[0] }, process.env.JWT_SECRET)]) {
    assert.equal((await query({ question }, auth)).status, 401);
  }
  assert.equal(calls, previous);
});

test("rejects malformed answers and invented citations without exposing raw output", async () => {
  for (const raw of ["PRIVATE_INVALID_OUTPUT", JSON.stringify({ status: "answered", answer: "Secret [S99]", citations: ["S99"] })]) {
    reply = () => raw;
    const result = await query({ question });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, "INVALID_ANSWER");
    assert.equal(result.body.data, undefined);
    assert.ok(!JSON.stringify(result.body).includes(raw));
  }
});

test("maps provider failures to safe HTTP errors without retries", async () => {
  for (const [code, expected] of [
    ["TIMEOUT", 504], ["BLOCKED", 422], ["QUOTA", 503], ["CONFIGURATION", 503],
    ["AUTHENTICATION", 503], ["MODEL_UNAVAILABLE", 503], ["NETWORK", 503], ["UNAVAILABLE", 503],
    ["INVALID_RESPONSE", 502], ["INCOMPLETE_RESPONSE", 502], ["REQUEST_REJECTED", 502],
  ]) {
    reply = () => { throw new provider.GeminiProviderError(code, "PRIVATE_PROVIDER_DETAILS"); };
    const previous = calls;
    const result = await query({ question });
    assert.equal(result.status, expected, code);
    assert.equal(result.body.success, false);
    assert.equal(calls, previous + 1);
    assert.ok(!JSON.stringify(result.body).includes("PRIVATE_PROVIDER_DETAILS"));
  }
});

test("unexpected failures return a generic 500", async () => {
  reply = () => { throw new Error("PRIVATE_DETAILS"); };
  const result = await query({ question });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "QUERY_FAILED");
  assert.ok(!JSON.stringify(result.body).includes("PRIVATE_DETAILS"));
});
