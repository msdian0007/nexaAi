// Exercise producer lifecycle without touching the application's Redis queue.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const queuePath = require.resolve('../dist/src/document/document.queue');
const runtimePath = require.resolve('../dist/src/document/document.queue.runtime');
const { DocumentQueueUnavailableError } = require(queuePath);
function runtime(factory) {
  require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true,
    exports: { createDocumentQueue: factory, DocumentQueueUnavailableError } };
  delete require.cache[runtimePath];
  return require(runtimePath);
}
function client() {
  return { ready: true, closed: 0, isReady() { return this.ready; }, async close() { this.closed++; } };
}

test('parallel requests share one producer and replace a disconnected connection once', async () => {
  const created = [];
  const service = runtime(async () => { const queue = client(); created.push(queue); return queue; });
  const results = await Promise.all([service.getDocumentQueue(), service.getDocumentQueue()]);
  assert.equal(created.length, 1);
  assert.equal(results[0], results[1]);
  created[0].ready = false;
  const replacements = await Promise.all([service.getDocumentQueue(), service.getDocumentQueue()]);
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, 1);
  assert.equal(replacements[0], replacements[1]);
  await service.closeDocumentQueue();
  assert.equal(created[1].closed, 1);
});

test('failed startup can recover on a later request without restarting the API', async () => {
  let calls = 0;
  const queue = client();
  const service = runtime(async () => { if (++calls === 1) throw new Error('Offline'); return queue; });
  await assert.rejects(service.getDocumentQueue(), /Offline/);
  assert.equal(await service.getDocumentQueue(), queue);
  await service.closeDocumentQueue();
});

test('shutdown waits for a connecting producer, closes it and rejects new work', async () => {
  let release;
  const queue = client();
  const service = runtime(() => new Promise(resolve => { release = resolve; }));
  const started = service.getDocumentQueue();
  const stopped = service.closeDocumentQueue();
  release(queue);
  await started;
  await stopped;
  assert.equal(queue.closed, 1);
  await assert.rejects(service.getDocumentQueue(), DocumentQueueUnavailableError);
});
