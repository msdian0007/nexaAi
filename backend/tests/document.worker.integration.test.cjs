// Real Redis, PostgreSQL, TXT extraction and local embeddings. No Gemini calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Queue } = require('bullmq');
const prisma = require('../dist/src/config/database').default;
const { createRedisConnection } = require('../dist/src/config/redis');
const { createDocumentQueue, DOCUMENT_JOB_NAME } = require('../dist/src/document/document.queue');
const { createDocumentWorker } = require('../dist/src/document/document.worker');

test('document worker processes isolated jobs with real infrastructure', { timeout: 180000 }, async t => {
  const id = randomUUID();
  const queueName = `nexaai-worker-test-${id}`;
  const root = path.resolve('uploads', 'documents');
  const directory = path.resolve(root, id);
  assert.equal(path.dirname(directory), root);
  const connection = createRedisConnection();
  let inspector, producer, worker, running, runError, created = false;
  const text = 'Fictional handbook: Employees receive 18 days of annual leave. Submit requests to a manager 7 days before leave.\n'.repeat(15);
  async function terminal(jobId) {
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      if (runError) throw new Error('Worker loop failed');
      const job = await inspector.getJob(jobId);
      // getState is a second Redis read: completion can happen after getJob.
      // Reload terminal data so failure reasons/results are not a stale snapshot.
      if (job && ['completed', 'failed'].includes(await job.getState())) return inspector.getJob(jobId);
      await delay(100);
    }
    throw new Error('Worker did not finish the fixture within 120 seconds');
  }
  try {
    await prisma.user.create({ data: {
      id, name: 'Worker test', email: `${id}@example.invalid`, password: 'unused',
      memberships: { create: { role: 'MEMBER', organization: { create: { id, name: 'Worker test', slug: `worker-${id}` } } } },
    } });
    created = true;
    await fs.mkdir(directory, { recursive: true });
    const storagePath = path.join(directory, 'fictional-handbook.txt');
    await fs.writeFile(storagePath, text);
    const document = await prisma.document.create({ data: {
      organizationId: id, uploadedById: id, name: 'fictional-handbook.txt', originalName: 'fictional-handbook.txt',
      mimeType: 'text/plain', size: Buffer.byteLength(text), storagePath,
    } });
    await connection.connect();
    inspector = new Queue(queueName, { connection });
    inspector.on('error', () => {});
    await inspector.waitUntilReady();
    producer = await createDocumentQueue({ queueName });

    // Prove that submitting work alone does not perform extraction.
    const wrong = await producer.enqueue({ documentId: document.id, organizationId: randomUUID() });
    assert.equal(await (await inspector.getJob(wrong.jobId)).getState(), 'waiting');
    worker = createDocumentWorker({ queueName });
    running = worker.run().catch(error => { runError = error; });

    await t.test('another organization cannot process or change the document', async () => {
      const job = await terminal(wrong.jobId);
      assert.equal(await job.getState(), 'failed');
      assert.equal(job.failedReason, 'Document is unavailable for this organization.');
      const untouched = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
      assert.equal(untouched.status, 'UPLOADED');
      assert.equal(untouched.extractedText, null);
      assert.equal(await prisma.documentChunk.count({ where: { documentId: document.id } }), 0);
    });

    await t.test('malformed payloads and unsupported job names are rejected', async () => {
      const malformed = await inspector.add(DOCUMENT_JOB_NAME, { documentId: '../private/file', organizationId: id });
      const unsupported = await inspector.add('unknown-operation', { documentId: document.id, organizationId: id });
      assert.equal((await terminal(malformed.id)).failedReason, 'Invalid document job data.');
      assert.equal((await terminal(unsupported.id)).failedReason, 'Unsupported document job.');
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status, 'UPLOADED');
    });

    await t.test('a valid job extracts text and saves chunks with 384-dimensional vectors', async () => {
      const result = await producer.enqueue({ documentId: document.id, organizationId: id });
      const job = await terminal(result.jobId);
      assert.equal(await job.getState(), 'completed', job.failedReason);
      assert.deepEqual(job.returnvalue, { documentId: document.id, status: 'COMPLETED' });
      const saved = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
      assert.equal(saved.status, 'COMPLETED');
      assert.equal(saved.extractedText, text);
      assert.equal(saved.errorMessage, null);
      assert.ok(saved.chunks.length > 1);
      assert.ok(saved.chunks.every(chunk => chunk.embeddingStatus === 'COMPLETED'));
      const vectors = await prisma.$queryRaw`
        SELECT vector_dims(embedding) AS dimensions FROM "DocumentChunk" WHERE "documentId" = ${document.id}`;
      assert.equal(vectors.length, saved.chunks.length);
      assert.ok(vectors.every(vector => vector.dimensions === 384));
      t.diagnostic(`Saved ${saved.chunks.length} chunks with real 384-dimensional embeddings.`);
    });

    await t.test('a missing file fails the job and document without copying its path into the job error', async () => {
      const broken = await prisma.document.create({ data: {
        organizationId: id, uploadedById: id, name: 'missing.txt', originalName: 'missing.txt',
        mimeType: 'text/plain', size: 1, storagePath: path.join(directory, 'missing.txt'),
      } });
      const result = await producer.enqueue({ documentId: broken.id, organizationId: id });
      const job = await terminal(result.jobId);
      assert.equal(await job.getState(), 'failed');
      assert.equal(job.failedReason, 'Document processing failed.');
      assert.equal(job.attemptsMade, 3);
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: broken.id } })).status, 'FAILED');

      // Repair the fictional input and explicitly give the retained job a fresh budget.
      await fs.writeFile(broken.storagePath, 'Employees receive 18 days of annual leave.');
      await producer.retryFailed({ documentId: broken.id, organizationId: id });
      const recovered = await terminal(result.jobId);
      assert.equal(await recovered.getState(), 'completed', recovered.failedReason);
      assert.equal(recovered.attemptsMade, 1);
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: broken.id } })).status, 'COMPLETED');
      await assert.rejects(producer.retryFailed({ documentId: broken.id, organizationId: id }), /existing failed/);
    });

    await t.test('graceful shutdown closes the loop and leaves subsequent jobs waiting', async () => {
      await Promise.all([worker.close(), worker.close()]);
      await running;
      assert.equal(runError, undefined);
      const later = await producer.enqueue({ documentId: randomUUID(), organizationId: id });
      assert.equal(await (await inspector.getJob(later.jobId)).getState(), 'waiting');
    });
  } finally {
    try {
      await worker?.close();
      await running;
      await producer?.close();
      if (inspector) {
        assert.equal(queueName, `nexaai-worker-test-${id}`);
        await inspector.obliterate();
        await inspector.close();
      }
      if (created) await prisma.$transaction([
        prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
      ]);
      // Remove only direct files in this test's verified tenant directory.
      const files = await fs.readdir(directory).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files) {
        const target = path.resolve(directory, file);
        assert.equal(path.dirname(target), directory);
        await fs.unlink(target);
      }
      await fs.rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
      t.diagnostic('Removed the isolated queue, fixture records and files.');
    } finally {
      connection.disconnect();
      await prisma.$disconnect();
    }
  }
});
