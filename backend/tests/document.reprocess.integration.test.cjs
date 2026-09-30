// Run after `npm run build`, against a local test/development database.
// Router, JWT, processing, chunk replacement, and PostgreSQL are real.
// Extraction and embedding are controlled stubs; no model download is needed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;

let extract;
let embeddingCalls;
function stubModule(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stubModule("../dist/src/document/document.extractor", {
  extractTextFromDocument: (...args) => extract(...args),
});
stubModule("../dist/src/document/document.embedding.service", {
  embedDocumentChunks: async documentId => {
    embeddingCalls++;
    const vector = `[${[1, ...Array(383).fill(0)].join(",")}]`;
    await prisma.$executeRaw`
      UPDATE "DocumentChunk"
      SET embedding = ${vector}::vector(384), "embeddingStatus" = 'COMPLETED'
      WHERE "documentId" = ${documentId}
    `;
  },
});
const router = require("../dist/src/document/document.routes").default;
let server;
let baseUrl;
const originalSecret = process.env.JWT_SECRET;

before(async () => {
  process.env.JWT_SECRET = randomUUID();
  const app = express();
  app.use(express.json());
  app.use("/api/v1/documents", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
});

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    await prisma.$disconnect();
  }
});

function tokenFor(organizationId) {
  return jwt.sign({ userId: organizationId, organizationId, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "5m" });
}

async function retry(id, token, body = {}) {
  const response = await fetch(`${baseUrl}/${encodeURIComponent(id)}/reprocess`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

async function withDocument(run) {
  const id = randomUUID();
  const document = await prisma.document.create({
    data: {
      name: "Retry test", originalName: "retry.txt", mimeType: "text/plain",
      size: 4, storagePath: "existing-upload.txt", status: "FAILED", errorMessage: "Previous failure",
      organization: { create: { id, name: "Retry test", slug: `retry-test-${id}` } },
      uploadedBy: { create: { id, name: "Retry test", email: `${id}@example.invalid`, password: "unused" } },
      chunks: { create: { chunkIndex: 0, content: "Old partial content", embeddingStatus: "FAILED" } },
    },
  });
  embeddingCalls = 0;
  extract = async (filePath, mimeType) => {
    assert.equal(filePath, document.storagePath);
    assert.equal(mimeType, document.mimeType);
    return "Recovered document content";
  };
  try {
    await run(document, tokenFor(id));
  } finally {
    await prisma.$transaction([
      prisma.document.delete({ where: { id: document.id } }),
      prisma.organization.delete({ where: { id } }),
      prisma.user.delete({ where: { id } }),
    ]);
  }
}

test("retries a failed document using its stored file and replaces partial chunks", async () => {
  await withDocument(async (document, token) => {
    const response = await retry(document.id, token);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { documentId: document.id, status: "COMPLETED", textLength: 26 });
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
    assert.equal(saved.status, "COMPLETED");
    assert.equal(saved.errorMessage, null);
    assert.equal(saved.chunks.length, 1);
    assert.equal(saved.chunks[0].content, "Recovered document content");
    assert.equal(saved.chunks[0].embeddingStatus, "COMPLETED");
    assert.equal(embeddingCalls, 1);
    const vectors = await prisma.$queryRaw`SELECT vector_dims(embedding) AS dimensions FROM "DocumentChunk" WHERE "documentId" = ${document.id}`;
    assert.deepEqual(vectors, [{ dimensions: 384 }]);
  });
});

test("rejects non-failed states without changing the document or its chunks", async () => {
  await withDocument(async (document, token) => {
    for (const status of ["UPLOADED", "PROCESSING", "COMPLETED"]) {
      const before = await prisma.document.update({ where: { id: document.id }, data: { status }, include: { chunks: true } });
      assert.equal((await retry(document.id, token)).status, 409);
      const after = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
      assert.deepEqual(after, before);
    }
    assert.equal(embeddingCalls, 0);
  });
});

test("tenant mismatch and missing documents return the same 404 without side effects", async () => {
  await withDocument(async (document, token) => {
    const before = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
    const wrongTenant = await retry(document.id, tokenFor(randomUUID()), { organizationId: document.organizationId });
    assert.equal(wrongTenant.status, 404);
    assert.deepEqual(wrongTenant, await retry(randomUUID(), token));
    assert.deepEqual(await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } }), before);
    assert.equal(embeddingCalls, 0);
  });
});

test("requires authentication, organization context, and a nonblank ID", async () => {
  const id = randomUUID();
  for (const token of [null, "invalid", jwt.sign({ userId: id }, process.env.JWT_SECRET)]) {
    assert.equal((await retry(id, token)).status, 401);
  }
  assert.equal((await retry(" ", tokenFor(id))).status, 400);
});

test("only one concurrent retry proceeds; a duplicate cannot overwrite its status", async () => {
  await withDocument(async (document, token) => {
    let entered;
    let release;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    extract = async () => { entered(); await blocked; return "Recovered document content"; };
    const first = retry(document.id, token);
    try {
      await Promise.race([started, first.then(() => { throw new Error("Retry finished before extraction"); })]);
      assert.equal((await retry(document.id, token)).status, 409);
      const active = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
      assert.equal(active.status, "PROCESSING");
      assert.equal(active.errorMessage, null);
    } finally {
      release();
      assert.equal((await first).status, 200);
    }
    assert.equal(embeddingCalls, 1);
  });
});

test("extraction failures and empty text remain FAILED, with a safe API error and a later retry allowed", async () => {
  await withDocument(async (document, token) => {
    for (const fail of [async () => { throw new Error("Private file path missing"); }, async () => "   "]) {
      extract = fail;
      const response = await retry(document.id, token);
      assert.deepEqual(response, { status: 500, body: { success: false, message: "Document reprocessing failed" } });
      const failed = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
      assert.equal(failed.status, "FAILED");
      assert.ok(failed.errorMessage);
    }
    assert.equal(embeddingCalls, 0);
    extract = async () => "Recovered document content";
    assert.equal((await retry(document.id, token)).status, 200);
  });
});
