// Real PostgreSQL, Redis, BullMQ and process termination. Deterministic text and
// vectors isolate recovery behavior from model startup and external services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Queue } = require('bullmq');
const prisma = require('../dist/src/config/database').default;
const { createRedisConnection } = require('../dist/src/config/redis');
const { createDocumentQueue } = require('../dist/src/document/document.queue');
function stub(modulePath, exports) {
  const id = require.resolve(modulePath);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
let embeddingFailure = false;
stub('../dist/src/document/document.extractor', {
  extractTextFromDocument: async () => 'Fictional handbook: 18 annual leave days.',
});
stub('../dist/src/document/document.embedding.service', {
  embedDocumentChunks: async (documentId, db) => {
    if (embeddingFailure) throw new Error('Simulated embedding failure');
    const vector = `[${[1, ...Array(383).fill(0)].join(',')}]`;
    await db.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vector}::vector(384),
      "embeddingStatus" = 'COMPLETED' WHERE "documentId" = ${documentId}`;
  },
});
const { createDocumentWorker } = require('../dist/src/document/document.worker');
const { processDocument, markInterruptedDocumentFailed } = require('../dist/src/document/document.processing');

test('crashed work rolls back and Redis redelivers it safely', { timeout: 60000 }, async t => {
  const id = randomUUID();
  const queueName = `nexaai-recovery-test-${id}`;
  const connection = createRedisConnection();
  let inspector, producer, child, worker, running, created = false;
  try {
    const document = await prisma.document.create({ data: {
      name: 'Recovery fixture', originalName: 'fictional.txt', mimeType: 'text/plain', size: 40,
      storagePath: path.join('uploads', 'documents', id, `${id}.txt`),
      organization: { create: { id, name: 'Recovery fixture', slug: `recovery-${id}` } },
      uploadedBy: { create: { id, name: 'Recovery fixture', email: `${id}@example.invalid`, password: 'unused' } },
    } });
    created = true;
    await connection.connect();
    inspector = new Queue(queueName, { connection });
    inspector.on('error', () => {});
    producer = await createDocumentQueue({ queueName });
    const data = { documentId: document.id, organizationId: id };
    const { jobId } = await producer.enqueue(data);
    child = fork(path.join(__dirname, 'fixtures/crash-document-worker.cjs'), [queueName], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(20000) });
    assert.equal(message, 'partial-work');
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status, 'PROCESSING');
    assert.equal(await prisma.documentChunk.count({ where: { documentId: document.id } }), 0,
      'Uncommitted chunks must not be visible');
    await assert.rejects(processDocument(document.id, id), /already being processed/);
    await markInterruptedDocumentFailed(document.id, id);
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status, 'PROCESSING');
    const exited = once(child, 'exit');
    child.kill('SIGKILL'); // Only the child created above; never kill an application worker.
    await exited;
    child = undefined;

    // Redis redelivers to a replacement process. Crash it too, exhausting the
    // allowed stalled-job recovery, then verify a deliberate retry still works.
    child = fork(path.join(__dirname, 'fixtures/crash-document-worker.cjs'), [queueName], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    assert.equal((await once(child, 'message', { signal: AbortSignal.timeout(20000) }))[0], 'partial-work');
    assert.equal((await inspector.getJob(jobId)).stalledCounter, 1);
    const secondExit = once(child, 'exit');
    child.kill('SIGKILL');
    await secondExit;
    child = undefined;

    worker = createDocumentWorker({ queueName, lockDuration: 2000, stalledInterval: 1000 });
    running = worker.run();
    const failureDeadline = Date.now() + 15000;
    while (Date.now() < failureDeadline) {
      if (await (await inspector.getJob(jobId)).getState() === 'failed' &&
          (await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status === 'FAILED') break;
      await delay(100);
    }
    assert.equal(await (await inspector.getJob(jobId)).getState(), 'failed');
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status, 'FAILED');
    await producer.retryFailed(data);
    const deadline = Date.now() + 20000;
    let job;
    while (Date.now() < deadline) {
      job = await inspector.getJob(jobId);
      if (await job.getState() === 'completed') break;
      await delay(100);
    }
    assert.equal(await job.getState(), 'completed');
    assert.equal((await inspector.getJob(jobId)).stalledCounter, 0);
    const completed = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.chunks.length, 1);
    assert.equal(completed.chunks[0].embeddingStatus, 'COMPLETED');

    // Even after Redis forgets a completed job ID, the database prevents rebuilding.
    await job.remove();
    await producer.enqueue(data);
    const until = Date.now() + 10000;
    while (Date.now() < until && await (await inspector.getJob(jobId)).getState() !== 'completed') await delay(50);
    assert.equal(await (await inspector.getJob(jobId)).getState(), 'completed');
    assert.deepEqual(await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } }), completed);

    // A failure after chunk replacement must restore the previous committed data.
    await prisma.document.update({ where: { id: document.id }, data: { status: 'FAILED' } });
    embeddingFailure = true;
    await assert.rejects(processDocument(document.id, id), /Simulated embedding failure/);
    const failed = await prisma.document.findUniqueOrThrow({ where: { id: document.id }, include: { chunks: true } });
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(failed.chunks, completed.chunks);
    t.diagnostic('Verified killed worker, actual stalled-job redelivery, atomic rollback and completed-job deduplication.');
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await worker?.close();
    await running;
    await producer?.close();
    if (inspector) {
      assert.equal(queueName, `nexaai-recovery-test-${id}`);
      await inspector.obliterate({ force: true });
      await inspector.close();
    }
    connection.disconnect();
    if (created) await prisma.$transaction([
      prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
    ]);
    await prisma.$disconnect();
  }
});
