// Real TXT upload, extraction, chunking, local embeddings, and PostgreSQL.
// Requires the local database and embedding model; run from backend after building.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;
const router = require("../dist/src/document/document.routes").default;
const { createDocumentQueue, DocumentQueueUnavailableError } = require('../dist/src/document/document.queue');
const { createDocumentWorker } = require('../dist/src/document/document.worker');
const { createRedisConnection } = require('../dist/src/config/redis');
const { Queue } = require('bullmq');
const { setTimeout: delay } = require('node:timers/promises');

test("a real upload completes with extracted text, chunks, and 384-dimensional vectors", { timeout: 180000 }, async t => {
  const id = randomUUID();
  const uploadRoot = path.resolve("uploads", "documents");
  const testDirectory = path.resolve(uploadRoot, id);
  assert.equal(path.dirname(testDirectory), uploadRoot);
  const originalSecret = process.env.JWT_SECRET;
  let created = false;
  let server;
  let producer, worker, running, inspector;
  const queueName = `nexaai-pipeline-test-${id}`;
  const connection = createRedisConnection();
  try {
    process.env.JWT_SECRET = randomUUID();
    await prisma.user.create({
      data: {
        id, name: "Pipeline test", email: `${id}@example.invalid`, password: "unused",
        memberships: { create: {
          role: "MEMBER",
          organization: { create: { id, name: "Pipeline test", slug: `pipeline-test-${id}` } },
        } },
      },
    });
    created = true;
    const token = jwt.sign({ userId: id, organizationId: id, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const app = express();
    producer = await createDocumentQueue({ queueName });
    await connection.connect();
    inspector = new Queue(queueName, { connection });
    inspector.on('error', () => {});
    app.locals.getDocumentQueue = async () => producer;
    app.use(express.json());
    app.use("/api/v1/documents", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
    const text = [
      "NexaAI employee handbook. Employees receive eighteen days of paid annual leave.",
      "Leave requests should be submitted to a manager before the planned absence.",
      "Each organization has its own private document collection and knowledge base.",
    ].join("\n").repeat(10);
    const form = new FormData();
    form.append("document", new Blob([text], { type: "text/plain" }), "pipeline-handbook.txt");
    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(150000),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.deepEqual(body.data, body.document);
    assert.equal(body.data.processingState, 'QUEUED');
    // The HTTP response arrives while NO worker is running: extraction cannot
    // have occurred in the request. The accepted file has no chunks yet.
    assert.equal(await prisma.documentChunk.count({ where: { documentId: body.data.id } }), 0);
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: body.data.id } })).status, 'UPLOADED');

    // Simulate an unavailable producer, retaining the saved record in the 503 response.
    app.locals.getDocumentQueue = async () => { throw new DocumentQueueUnavailableError(); };
    const uncertain = await fetch(`${baseUrl}/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const saved = await uncertain.json();
    assert.equal(uncertain.status, 503);
    assert.equal(saved.success, false);
    assert.equal(saved.data.processingState, 'UNAVAILABLE');
    assert.ok(saved.data.id);
    assert.equal(saved.data.storagePath, undefined);
    app.locals.getDocumentQueue = async () => producer;
    const beforeRetry = await fetch(`${baseUrl}/${saved.data.id}/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await beforeRetry.json()).data.processingState, 'NOT_QUEUED');
    const retried = await fetch(`${baseUrl}/${saved.data.id}/reprocess`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(retried.status, 202);
    assert.equal((await retried.json()).data.id, saved.data.id);
    assert.equal(await prisma.document.count({ where: { organizationId: id } }), 2, 'Retry must not create another document');
    // Losing the enqueue acknowledgement is ambiguous: Redis may already have
    // the job. Never mark that saved document FAILED or create a second job.
    app.locals.getDocumentQueue = async () => ({ ...producer, enqueue: async data => {
      await producer.enqueue(data);
      throw new DocumentQueueUnavailableError();
    } });
    const ambiguous = await fetch(`${baseUrl}/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    assert.equal(ambiguous.status, 503);
    const ambiguousDocument = (await ambiguous.json()).data;
    app.locals.getDocumentQueue = async () => producer;
    const confirmed = await fetch(`${baseUrl}/${ambiguousDocument.id}/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await confirmed.json()).data.processingState, 'QUEUED');
    const duplicate = await fetch(`${baseUrl}/${ambiguousDocument.id}/reprocess`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(duplicate.status, 409);
    assert.equal(await inspector.getWaitingCount(), 3);
    worker = createDocumentWorker({ queueName });
    running = worker.run();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (await prisma.document.count({ where: { organizationId: id, status: 'COMPLETED' } }) === 3) break;
      await delay(100);
    }
    assert.equal(await prisma.document.count({ where: { organizationId: id, status: 'COMPLETED' } }), 3);
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: body.document.id }, include: { chunks: { orderBy: { chunkIndex: "asc" } } },
    });
    assert.equal(document.organizationId, id);
    assert.equal(document.status, "COMPLETED");
    assert.equal(document.errorMessage, null);
    assert.equal(document.extractedText, text);
    assert.equal(document.originalName, "pipeline-handbook.txt");
    assert.ok(document.chunks.length > 1, "Test must exercise multiple chunks");
    document.chunks.forEach((chunk, index) => {
      assert.equal(chunk.chunkIndex, index);
      assert.equal(chunk.embeddingStatus, "COMPLETED");
      assert.ok(chunk.content.trim());
    });
    const storedFile = path.resolve(document.storagePath);
    assert.equal(path.dirname(storedFile), testDirectory);
    assert.equal(await fs.readFile(storedFile, "utf8"), text);
    const vectors = await prisma.$queryRaw`
      SELECT vector_dims(embedding) AS dimensions, embedding::text AS vector
      FROM "DocumentChunk" WHERE "documentId" = ${document.id}
    `;
    assert.equal(vectors.length, document.chunks.length);
    for (const row of vectors) {
      assert.equal(row.dimensions, 384);
      const vector = JSON.parse(row.vector);
      assert.equal(vector.length, 384);
      assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.001, "Embedding should be normalized");
    }
    const statusResponse = await fetch(`${baseUrl}/${document.id}/status`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).data.status, "COMPLETED");
    t.diagnostic(`Verified ${document.chunks.length} chunks, ${vectors.length} real vectors, 384 dimensions each.`);
    // Acceptance and readiness are separate responses; the initial result is queued.
    assert.equal(body.document.status, "UPLOADED");
    assert.equal(body.document.errorMessage, null);
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await worker?.close();
      await running;
      await producer?.close();
      if (inspector) {
        assert.equal(queueName, `nexaai-pipeline-test-${id}`);
        await inspector.obliterate();
        await inspector.close();
      }
      connection.disconnect();
      if (created) {
        await prisma.$transaction([
          prisma.document.deleteMany({ where: { organizationId: id } }),
          prisma.organization.delete({ where: { id } }),
          prisma.user.delete({ where: { id } }),
        ]);
      }
      // Only remove files directly inside this test's verified, unique tenant directory.
      const files = await fs.readdir(testDirectory).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const file of files) {
        const target = path.resolve(testDirectory, file);
        assert.equal(path.dirname(target), testDirectory);
        await fs.unlink(target);
      }
      await fs.rmdir(testDirectory).catch(error => { if (error.code !== "ENOENT") throw error; });
      t.diagnostic("Removed isolated test records and uploaded files.");
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
    }
  }
});
