// Isolated real PostgreSQL, filesystem and Redis. Deterministic embeddings avoid
// model startup; the actual processor, retrieval SQL and queue removal still run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Queue, Worker } = require('bullmq');
const prisma = require('../dist/src/config/database').default;
const vector = [1, ...Array(383).fill(0)];
function stub(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; }
let extractionGate;
stub('../dist/src/document/document.embedding', { generateEmbedding: async () => vector });
stub('../dist/src/document/document.embedding.service', { embedDocumentChunks: async () => {} });
stub('../dist/src/document/document.extractor', { extractTextFromDocument: async filename => {
  if (extractionGate) { extractionGate.started(); await extractionGate.wait; }
  return fs.readFile(path.resolve(filename), 'utf8');
} });
const router = require('../dist/src/document/document.routes').default;
const { processDocument } = require('../dist/src/document/document.processing');
const { searchDocumentChunks } = require('../dist/src/document/document.search');
const { createDocumentQueue, DOCUMENT_JOB_NAME } = require('../dist/src/document/document.queue');
const { createRedisConnection, createWorkerRedisConnection } = require('../dist/src/config/redis');

test('document deletion coordinates jobs, stored files, retrieval and saved citations', { timeout: 90000 }, async t => {
  const organizationId = randomUUID(), otherOrg = randomUUID();
  const users = Object.fromEntries(['owner', 'admin', 'member'].map(name => [name, randomUUID()]));
  const root = path.resolve('uploads', 'documents', organizationId);
  assert.equal(path.dirname(root), path.resolve('uploads', 'documents'));
  const createdPaths = [];
  const queueName = `nexaai-deletion-test-${organizationId}`;
  const connection = createRedisConnection();
  const oldSecret = process.env.JWT_SECRET;
  let server, producer, inspector, worker, workerConnection, unavailable = false;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const id of [organizationId, otherOrg]) await prisma.organization.create({ data: { id, name: 'Deletion fixture', slug: `delete-${id}` } });
    for (const [role, id] of Object.entries(users)) {
      await prisma.user.create({ data: { id, name: role, email: `${id}@example.invalid`, password: 'fixture' } });
      await prisma.organizationMember.create({ data: { userId: id, organizationId, role: role.toUpperCase() } });
    }
    await fs.mkdir(root, { recursive: true });
    producer = await createDocumentQueue({ queueName });
    await connection.connect(); inspector = new Queue(queueName, { connection }); inspector.on('error', () => {});
    const app = express(); app.use(express.json());
    app.locals.getDocumentQueue = async () => { if (unavailable) throw new Error('Simulated private queue failure'); return producer; };
    app.use('/documents', router); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const token = (name = 'owner', org = organizationId) => jwt.sign({ userId: users[name], organizationId: org, role: 'OWNER' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    async function call(id, auth = token(), method = 'DELETE', body, query = '') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/documents/${id}${query}`, {
        method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      return { status: response.status, body: await response.json() };
    }
    async function create(status = 'COMPLETED') {
      const id = randomUUID(), target = path.join(root, `${id}.txt`); createdPaths.push(target);
      await fs.writeFile(target, 'Fictional handbook: eighteen days of leave.');
      const document = await prisma.document.create({ data: { id, organizationId, uploadedById: users.owner,
        name: `${id}.txt`, originalName: 'Fictional handbook.txt', mimeType: 'text/plain', size: 42,
        storagePath: path.relative(process.cwd(), target), status, extractedText: 'fixture text',
        chunks: { create: { chunkIndex: 0, content: 'Eighteen days of leave.', embeddingStatus: 'COMPLETED' } },
      }, include: { chunks: true } });
      await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${JSON.stringify(vector)}::vector(384) WHERE "documentId" = ${id}`;
      return { ...document, target, data: { documentId: id, organizationId } };
    }
    await t.test('current manager permission, target scope and input checks precede all destruction', async () => {
      const doc = await create();
      assert.equal((await call(doc.id, token('member'))).status, 403);
      assert.equal((await call(doc.id, null)).status, 401);
      assert.equal((await call('invalid')).status, 400);
      assert.equal((await call(doc.id, token(), 'DELETE', { organizationId: otherOrg })).status, 400);
      const foreign = await prisma.document.create({ data: { organizationId: otherOrg, uploadedById: users.owner, name: 'foreign', originalName: 'foreign.txt', mimeType: 'text/plain', size: 1, storagePath: 'never-touch-this' } });
      const hidden = await call(foreign.id), missing = await call(randomUUID());
      assert.equal(hidden.status, 404); assert.deepEqual(hidden, missing);
      assert.ok(await fs.readFile(doc.target));
      await prisma.organizationMember.update({ where: { userId_organizationId: { userId: users.admin, organizationId } }, data: { role: 'MEMBER' } });
      assert.equal((await call(doc.id, token('admin'))).status, 403);
      await prisma.organizationMember.update({ where: { userId_organizationId: { userId: users.admin, organizationId } }, data: { role: 'ADMIN' } });
      assert.equal((await call(doc.id, token('admin'))).status, 200);
    });
    await t.test('delete removes waiting jobs, exact file, chunks and retrieval but preserves citation snapshots', async () => {
      const doc = await create(); const { jobId } = await producer.enqueue(doc.data);
      const thread = await prisma.conversation.create({ data: { userId: users.owner, organizationId, title: 'Saved answer' } });
      const message = await prisma.message.create({ data: { conversationId: thread.id, organizationId, role: 'ASSISTANT', sequence: 0, answerStatus: 'answered', content: 'Eighteen days [S1].' } });
      await prisma.messageSource.create({ data: { messageId: message.id, organizationId, sourceId: 'S1', documentId: doc.id, chunkId: doc.chunks[0].id, documentName: doc.originalName, chunkIndex: 0, similarity: 1 } });
      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: thread.id }, include: { messages: { include: { sources: true } } } });
      assert.ok((await searchDocumentChunks(organizationId, 'leave', 20)).some(row => row.documentId === doc.id));
      const deleted = await call(doc.id); assert.equal(deleted.status, 200); assert.equal(deleted.body.data.deleted, true);
      assert.equal(await prisma.document.findUnique({ where: { id: doc.id } }), null);
      assert.equal(await prisma.documentChunk.count({ where: { documentId: doc.id } }), 0);
      await assert.rejects(fs.stat(doc.target), { code: 'ENOENT' }); assert.equal(await inspector.getJob(jobId), undefined);
      assert.ok(!(await searchDocumentChunks(organizationId, 'leave', 20)).some(row => row.documentId === doc.id));
      assert.deepEqual(await prisma.conversation.findUnique({ where: { id: conversation.id }, include: { messages: { include: { sources: true } } } }), conversation);
      await assert.rejects(processDocument(doc.id, organizationId), /not found/i);
    });
    await t.test('queue outage leaves durable blocked intent and Finish deletion resumes cleanup', async () => {
      const doc = await create('COMPLETED'); await producer.enqueue(doc.data);
      unavailable = true;
      const pending = await call(doc.id); assert.equal(pending.status, 202); assert.equal(pending.body.data.cleanupPending, true);
      assert.ok((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).deletionRequestedAt);
      assert.equal(await prisma.documentChunk.count({ where: { documentId: doc.id } }), 0);
      // Even inconsistent late chunks must not make a marked document eligible.
      await prisma.documentChunk.create({ data: { documentId: doc.id, chunkIndex: 0, content: 'Old late write', embeddingStatus: 'COMPLETED' } });
      await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${JSON.stringify(vector)}::vector(384) WHERE "documentId" = ${doc.id}`;
      assert.ok(!(await searchDocumentChunks(organizationId, 'leave', 20)).some(row => row.documentId === doc.id));
      assert.ok(await fs.readFile(doc.target));
      assert.equal((await call(`${doc.id}/status`, token(), 'GET')).body.data.processingState, 'DELETING');
      assert.equal((await call(`${doc.id}/reprocess`, token(), 'POST')).status, 409);
      await assert.rejects(processDocument(doc.id, organizationId), /not found/i);
      unavailable = false; assert.equal((await call(doc.id)).body.data.deleted, true);
    });
    await t.test('a real processing transaction prevents deletion until it releases its lock', async () => {
      const doc = await create('UPLOADED'); let start, release;
      const started = new Promise(resolve => { start = resolve; });
      extractionGate = { started: start, wait: new Promise(resolve => { release = resolve; }) };
      const running = processDocument(doc.id, organizationId);
      try {
        await started; assert.equal((await call(doc.id)).status, 409);
        assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).deletionRequestedAt, null);
      } finally { release(); await running; extractionGate = undefined; }
      assert.equal((await call(doc.id)).status, 200);
    });
    await t.test('an active Redis job is not force-removed and cleanup can resume when it finishes', async () => {
      const doc = await create(); let release, start;
      const started = new Promise(resolve => { start = resolve; }); const gate = new Promise(resolve => { release = resolve; });
      workerConnection = createWorkerRedisConnection();
      worker = new Worker(queueName, async job => { if (job.data.documentId === doc.id) { start(); await gate; } }, { connection: workerConnection });
      worker.on('error', () => {});
      const { jobId } = await producer.enqueue(doc.data);
      try { await started; const result = await call(doc.id); assert.equal(result.status, 202); assert.ok(await inspector.getJob(jobId)); }
      finally { release(); await worker.close(); worker = undefined; workerConnection.disconnect(); }
      assert.equal((await call(doc.id)).body.data.deleted, true);
    });
    await t.test('missing files and failed file cleanup are recoverable; unsafe paths are never unlinked', async () => {
      const missing = await create(); await fs.unlink(missing.target); assert.equal((await call(missing.id)).status, 200);
      const blocked = await create(); await fs.unlink(blocked.target); await fs.mkdir(blocked.target);
      const pending = await call(blocked.id); assert.equal(pending.status, 202);
      await fs.rmdir(blocked.target); await fs.writeFile(blocked.target, 'fixture');
      assert.equal((await call(blocked.id)).status, 200);
      const unsafe = await create();
      await prisma.document.update({ where: { id: unsafe.id }, data: { storagePath: '../outside-workspace.txt' } });
      assert.equal((await call(unsafe.id)).status, 409); assert.ok(await fs.readFile(unsafe.target));
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: unsafe.id } })).deletionRequestedAt, null);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await worker?.close(); workerConnection?.disconnect(); await producer?.close();
    if (inspector) { await inspector.obliterate({ force: true }); await inspector.close(); } connection.disconnect();
    try {
      await prisma.organization.deleteMany({ where: { id: { in: [organizationId, otherOrg] } } });
      await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
      // Only exact files created above, all checked inside this isolated tenant folder.
      for (const target of createdPaths) { assert.equal(path.dirname(target), root); await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      await fs.rmdir(root);
    } finally { if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; await prisma.$disconnect(); }
  }
});
