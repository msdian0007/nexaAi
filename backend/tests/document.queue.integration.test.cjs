// Real Redis, but a unique queue per run. No document processing or Gemini calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const { Queue } = require('bullmq');
const { createRedisConnection } = require('../dist/src/config/redis');
const { createDocumentQueue, DOCUMENT_JOB_NAME, parseDocumentJobData, DocumentQueueUnavailableError } = require('../dist/src/document/document.queue');

test('rejects invalid job identities and strips file paths, content and extra fields', () => {
  for (const value of [null, {}, [], { documentId: '../file', organizationId: randomUUID() }]) {
    assert.throws(() => parseDocumentJobData(value), /valid document and organization UUIDs/);
  }
  const data = { documentId: randomUUID(), organizationId: randomUUID() };
  assert.deepEqual(parseDocumentJobData({ ...data, storagePath: '/private/file', content: 'private', token: 'secret' }), data);
});

test('stores waiting jobs, deduplicates concurrent submissions, and survives producer reconnection', { timeout: 30000 }, async t => {
  const queueName = `nexaai-documents-test-${randomUUID()}`;
  const connection = createRedisConnection();
  let producer, inspector;
  try {
    await connection.connect();
    inspector = new Queue(queueName, { connection });
    inspector.on('error', () => {});
    await inspector.waitUntilReady();
    producer = await createDocumentQueue({ queueName });
    const data = { documentId: randomUUID(), organizationId: randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => producer.enqueue({ ...data, content: 'must not be stored' })));
    assert.equal(new Set(results.map(item => item.jobId)).size, 1);
    assert.equal(await inspector.getWaitingCount(), 1);
    const stored = await inspector.getJob(results[0].jobId);
    assert.equal(stored.name, DOCUMENT_JOB_NAME);
    assert.deepEqual(stored.data, data);
    assert.equal(await stored.getState(), 'waiting');
    assert.equal(stored.opts.attempts, 1);
    assert.equal(stored.opts.removeOnComplete, false);
    assert.equal(stored.opts.removeOnFail, false);

    await producer.close();
    await producer.close(); // Shutdown is safe to call more than once.
    await assert.rejects(producer.enqueue(data), DocumentQueueUnavailableError);
    producer = await createDocumentQueue({ queueName });
    assert.deepEqual(await producer.enqueue(data), results[0]);
    assert.equal(await inspector.getWaitingCount(), 1);

    // Including the organization in the ID separates these synthetic instructions.
    // This does not authorize either payload; the worker must check the database.
    const other = await producer.enqueue({ ...data, organizationId: randomUUID() });
    assert.notEqual(other.jobId, results[0].jobId);
    assert.equal(await inspector.getWaitingCount(), 2);
    await assert.rejects(producer.enqueue({ ...data, documentId: 'invalid' }));
    assert.equal(await inspector.getWaitingCount(), 2);
    t.diagnostic('Verified two waiting jobs, ID-only payloads, concurrent deduplication and producer reconnection.');
  } finally {
    try {
      await producer?.close();
      if (inspector) {
        // Only this run's random queue is removed. Never FLUSHDB/FLUSHALL or remove
        // the application queue; other Redis data can coexist with these fixtures.
        assert.match(queueName, /^nexaai-documents-test-[0-9a-f-]{36}$/);
        await inspector.obliterate();
        await inspector.close();
      }
    } finally { connection.disconnect(); }
  }
});

test('a silent Redis endpoint fails within the startup deadline and hides credentials', { timeout: 18000 }, async () => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await assert.rejects(createDocumentQueue({ url: `redis://user:private-password@127.0.0.1:${server.address().port}/0` }), error => {
      assert.ok(error instanceof DocumentQueueUnavailableError);
      assert.equal(error.message, 'Document processing queue is unavailable.');
      return true;
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
