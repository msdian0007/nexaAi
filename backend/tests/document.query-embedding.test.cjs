const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createQueryEmbeddingCache } = require('../dist/src/document/document.query-embedding');
const vector = () => [1, ...Array(383).fill(0)];
const org = randomUUID(), foreign = randomUUID();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('repeated queries reuse valid vectors only in the same organization and return independent copies', async () => {
  let calls = 0;
  const original = vector();
  const cache = createQueryEmbeddingCache({ generate: async () => { calls++; return original; } });
  const first = await cache.get(org, 'Question?'); first[0] = 99;
  original[0] = 42;
  assert.equal((await cache.get(org, 'Question?'))[0], 1);
  assert.equal(calls, 1);
  await cache.get(foreign, 'Question?'); assert.equal(calls, 2);
  await cache.get(org, 'question?'); assert.equal(calls, 3);
  await cache.get(org, 'Question? '); assert.equal(calls, 4);
});

test('expiry starts at completed fill; reads do not extend it and the exact boundary misses', async () => {
  let time = 0, calls = 0;
  const cache = createQueryEmbeddingCache({ ttlMs: 100, now: () => time, generate: async () => { calls++; time += 10; return vector(); } });
  await cache.get(org, 'Question?');
  time = 109; await cache.get(org, 'Question?'); assert.equal(calls, 1);
  time = 110; await cache.get(org, 'Question?'); assert.equal(calls, 2);
});

test('least-recently-used eviction bounds retained entries and expires old entries before reuse', async () => {
  let calls = 0;
  const cache = createQueryEmbeddingCache({ maxEntries: 2, generate: async () => { calls++; return vector(); } });
  await cache.get(org, 'A'); await cache.get(org, 'B'); await cache.get(org, 'A');
  await cache.get(org, 'C'); await cache.get(org, 'A'); assert.equal(calls, 3);
  await cache.get(org, 'B'); assert.equal(calls, 4);
});

test('simultaneous identical misses share one inference and every waiter receives its own copy', async () => {
  let calls = 0;
  const gate = deferred();
  const cache = createQueryEmbeddingCache({ generate: async () => { calls++; await gate.promise; return vector(); } });
  const requests = Array.from({ length: 30 }, () => cache.get(org, 'Question?'));
  assert.equal(calls, 1); gate.resolve();
  const results = await Promise.all(requests);
  results[0][0] = 99;
  assert.ok(results.slice(1).every(result => result[0] === 1));
  assert.equal((await cache.get(org, 'Question?'))[0], 1);
});

test('failed in-flight work rejects all waiters without caching the failure; the next request can recover', async () => {
  const gate = deferred(); let calls = 0;
  const failure = new Error('controlled failure');
  const cache = createQueryEmbeddingCache({ generate: async () => { calls++; if (calls === 1) { await gate.promise; throw failure; } return vector(); } });
  const first = cache.get(org, 'Q'), second = cache.get(org, 'Q');
  const one = assert.rejects(first, error => error === failure), two = assert.rejects(second, error => error === failure);
  gate.resolve(); await Promise.all([one, two]);
  assert.equal(calls, 1); await cache.get(org, 'Q'); assert.equal(calls, 2);
});

test('bad dimensions, nonfinite and zero vectors are never cached', async () => {
  for (const invalid of [[], Array(383).fill(1), Array(384).fill(0), [NaN, ...Array(383).fill(0)], [Infinity, ...Array(383).fill(0)]]) {
    let calls = 0;
    const cache = createQueryEmbeddingCache({ generate: async () => { calls++; return calls === 1 ? invalid : vector(); } });
    await assert.rejects(cache.get(org, 'Q'), /Invalid query embedding/);
    await cache.get(org, 'Q'); assert.equal(calls, 2);
  }
});

test('a full pending map bypasses caching for new distinct work and keeps existing single-flight protection', async () => {
  let calls = 0;
  const gate = deferred();
  const cache = createQueryEmbeddingCache({ maxPending: 1, generate: async text => { calls++; if (text === 'A') await gate.promise; return vector(); } });
  const first = cache.get(org, 'A'), same = cache.get(org, 'A');
  await cache.get(org, 'B'); await cache.get(org, 'B'); assert.equal(calls, 3);
  gate.resolve(); await Promise.all([first, same]);
  await cache.get(org, 'B'); await cache.get(org, 'B'); assert.equal(calls, 4);
});

test('invalid scope, query and unbounded configuration fail before inference', async () => {
  let calls = 0;
  const cache = createQueryEmbeddingCache({ generate: async () => { calls++; return vector(); } });
  for (const [scope, query] of [['bad', 'Q'], [org, ''], [org, ' '], [org, 'x'.repeat(1001)], [org, null]]) await assert.rejects(cache.get(scope, query));
  assert.equal(calls, 0);
  for (const options of [{ ttlMs: 0 }, { ttlMs: 300001 }, { maxEntries: 129 }, { maxEntries: 0 }, { maxPending: 17 }, { maxPending: 0 }, { ttlMs: NaN }, { maxEntries: 1.5 }]) assert.throws(() => createQueryEmbeddingCache(options));
});
