// Real HTTP/JWT, PostgreSQL and Redis. These requests submit jobs; the API never extracts text.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Queue, Worker, UnrecoverableError } = require("bullmq");
const prisma = require("../dist/src/config/database").default;
const { createDocumentQueue } = require("../dist/src/document/document.queue");
const { createRedisConnection, createWorkerRedisConnection } = require("../dist/src/config/redis");
const router = require("../dist/src/document/document.routes").default;
const queueName = `nexaai-reprocess-test-${randomUUID()}`;
const connection = createRedisConnection();
let server, baseUrl, producer, inspector;
const originalSecret = process.env.JWT_SECRET;

before(async () => {
  process.env.JWT_SECRET = randomUUID();
  producer = await createDocumentQueue({ queueName });
  await connection.connect();
  inspector = new Queue(queueName, { connection });
  inspector.on('error', () => {});
  const app = express();
  app.locals.getDocumentQueue = async () => producer;
  app.use(express.json());
  app.use("/api/v1/documents", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
});

after(async () => {
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    await producer?.close();
    if (inspector) {
      assert.match(queueName, /^nexaai-reprocess-test-[0-9a-f-]{36}$/);
      await inspector.obliterate();
      await inspector.close();
    }
  } finally {
    connection.disconnect();
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
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
async function withDocument(run) {
  const id = randomUUID();
  const document = await prisma.document.create({ data: {
    name: "Retry test", originalName: "retry.txt", mimeType: "text/plain", size: 4,
    storagePath: "intentionally-missing-file.txt", status: "FAILED", errorMessage: "Private previous error",
    organization: { create: { id, name: "Retry test", slug: `retry-test-${id}` } },
    uploadedBy: { create: { id, name: "Retry test", email: `${id}@example.invalid`, password: "unused" } },
    chunks: { create: { chunkIndex: 0, content: "Old partial content", embeddingStatus: "FAILED" } },
  } });
  try { await run(document, tokenFor(id)); }
  finally {
    const job = await inspector.getJob(`document-${id}-${document.id}`);
    await job?.remove();
    await prisma.$transaction([
      prisma.document.delete({ where: { id: document.id } }),
      prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
    ]);
  }
}

test("a missing job is submitted without reading the file or changing partial chunks", async () => {
  await withDocument(async (document, token) => {
    const before = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
    const response = await retry(document.id, token);
    assert.equal(response.status, 202);
    assert.equal(response.body.data.id, document.id);
    assert.equal(response.body.data.processingState, "QUEUED");
    assert.equal(response.body.data.canRetry, false);
    assert.equal(response.body.data.storagePath, undefined);
    assert.equal(await producer.getState({ documentId: document.id, organizationId: document.organizationId }), 'waiting');
    assert.deepEqual(await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } }), before);
    assert.equal((await retry(document.id, token)).status, 409);
  });
});

test("completed documents cannot be requeued even after Redis removes their history", async () => {
  await withDocument(async (document, token) => {
    await prisma.document.update({ where: { id: document.id }, data: { status: "COMPLETED" } });
    assert.equal((await retry(document.id, token)).status, 409);
    assert.equal(await producer.getState({ documentId: document.id, organizationId: document.organizationId }), 'unknown');
  });
});

test("saved UPLOADED and interrupted PROCESSING records with missing jobs can recover", async () => {
  for (const status of ["UPLOADED", "PROCESSING"]) await withDocument(async (document, token) => {
    await prisma.document.update({ where: { id: document.id }, data: { status } });
    assert.equal((await retry(document.id, token)).status, 202);
  });
});

test("concurrent retry of a retained failed job creates only one waiting instruction", async () => {
  await withDocument(async (document, token) => {
    const data = { documentId: document.id, organizationId: document.organizationId };
    const { jobId } = await producer.enqueue(data);
    const workerConnection = createWorkerRedisConnection();
    const worker = new Worker(queueName, async () => { throw new UnrecoverableError("Fixture failure"); }, { connection: workerConnection });
    worker.on('error', () => {});
    try {
      const until = Date.now() + 5000;
      while (Date.now() < until && await producer.getState(data) !== 'failed') await delay(50);
      assert.equal(await producer.getState(data), 'failed');
    } finally { await worker.close(); workerConnection.disconnect(); }
    const responses = await Promise.all([retry(document.id, token), retry(document.id, token)]);
    assert.deepEqual(responses.map(item => item.status).sort(), [202, 409]);
    assert.equal(await inspector.getWaitingCount(), 1);
    assert.equal((await inspector.getJob(jobId)).attemptsMade, 0);
  });
});

test("tenant mismatch and missing IDs return the same 404 without touching the job", async () => {
  await withDocument(async (document, token) => {
    const wrong = await retry(document.id, tokenFor(randomUUID()), { organizationId: document.organizationId });
    assert.equal(wrong.status, 404);
    assert.deepEqual(wrong, await retry(randomUUID(), token));
    assert.equal(await inspector.getWaitingCount(), 0);
  });
});

test("requires authentication, organization context, and a nonblank ID", async () => {
  const id = randomUUID();
  for (const token of [null, "invalid", jwt.sign({ userId: id }, process.env.JWT_SECRET)]) {
    assert.equal((await retry(id, token)).status, 401);
  }
  assert.equal((await retry(" ", tokenFor(id))).status, 400);
});
