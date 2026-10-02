// Real local embeddings, authenticated HTTP requests, and PostgreSQL search.
// Run from backend after building, against a test/development database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;
const { generateEmbedding } = require("../dist/src/document/document.embedding");
const router = require("../dist/src/document/document.routes").default;
const tenants = [];
const question = "How much paid time off do employees get?";
let server, baseUrl, token, ownChunk, otherChunk;
const originalSecret = process.env.JWT_SECRET;

async function createTenant() {
  const id = randomUUID();
  await prisma.user.create({ data: {
    id, name: "Search test", email: `${id}@example.invalid`, password: "unused",
    memberships: { create: { role: "MEMBER", organization: { create: { id, name: "Search test", slug: `search-test-${id}` } } } },
  } });
  tenants.push(id);
  return id;
}

async function addChunk(tenant, content, status = "COMPLETED", embeddingStatus = "COMPLETED", hasVector = true) {
  const document = await prisma.document.create({ data: {
    organizationId: tenant, uploadedById: tenant, name: "test", originalName: "handbook.txt",
    mimeType: "text/plain", size: content.length, storagePath: "unused", status,
    chunks: { create: { chunkIndex: 0, content, embeddingStatus } },
  }, include: { chunks: true } });
  const chunk = document.chunks[0];
  if (hasVector) {
    const vector = `[${(await generateEmbedding(content)).join(",")}]`;
    await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vector}::vector(384) WHERE id = ${chunk.id}`;
  }
  return chunk;
}

before(async () => {
  process.env.JWT_SECRET = randomUUID();
  const own = await createTenant();
  const other = await createTenant();
  ownChunk = await addChunk(own, "Employees receive eighteen days of paid annual leave each year.");
  await addChunk(own, "Bake the chocolate cake in the oven for forty minutes.");
  // These exact question matches must be excluded despite their high similarity.
  otherChunk = await addChunk(other, question);
  await addChunk(own, question, "FAILED");
  await addChunk(own, question, "PROCESSING");
  await addChunk(own, question, "UPLOADED");
  await addChunk(own, question, "COMPLETED", "FAILED");
  await addChunk(own, question, "COMPLETED", "PENDING");
  await addChunk(own, question, "COMPLETED", "COMPLETED", false);
  token = jwt.sign({ userId: own, organizationId: own, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "5m" });
  const app = express();
  app.use(express.json());
  app.use("/api/v1/documents", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/documents/search`;
});

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const id of tenants) await prisma.$transaction([
      prisma.document.deleteMany({ where: { organizationId: id } }),
      prisma.organization.delete({ where: { id } }),
      prisma.user.delete({ where: { id } }),
    ]);
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    await prisma.$disconnect();
  }
});

async function search(body, authorization = token) {
  const response = await fetch(baseUrl, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}

test("ranks real semantic matches and excludes other tenants and incomplete content", async () => {
  const response = await search({ query: question, organizationId: tenants[1] });
  assert.equal(response.status, 200);
  const results = response.body.data.results;
  assert.equal(results.length, 2);
  assert.equal(results[0].chunkId, ownChunk.id);
  assert.equal(results[0].documentId, ownChunk.documentId);
  assert.equal(results[0].documentName, "handbook.txt");
  assert.equal(results[0].content, ownChunk.content);
  assert.ok(results[0].similarity > results[1].similarity);
  assert.ok(results.every(result => Number.isFinite(result.similarity) && result.chunkId !== otherChunk.id));
  assert.equal((await search({ query: question, topK: 1 })).body.data.results.length, 1);
});

test("an organization with no indexed documents receives an empty list", async () => {
  const empty = await createTenant();
  const emptyToken = jwt.sign({ userId: empty, organizationId: empty, role: "MEMBER" }, process.env.JWT_SECRET);
  const response = await search({ query: question }, emptyToken);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.results, []);
});

test("validates query and topK before running search", async () => {
  for (const body of [{}, { query: " " }, { query: 42 }, { query: "x".repeat(1001) },
    ...[0, 11, 1.5, "3", null].map(topK => ({ query: question, topK }))]) {
    assert.equal((await search(body)).status, 400);
  }
});

test("requires authentication and signed organization context", async () => {
  const noContext = jwt.sign({ userId: tenants[0] }, process.env.JWT_SECRET);
  for (const authorization of [null, "invalid", noContext]) {
    assert.equal((await search({ query: question }, authorization)).status, 401);
  }
});
