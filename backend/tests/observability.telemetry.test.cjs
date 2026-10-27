const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { requestTelemetry, measure, emit, traceId, withJobTrace } = require('../dist/src/observability/telemetry');

test('parallel traces stay isolated and logs reject arbitrary fields, headers, paths and errors', async () => {
  const records = [], canary = 'PRIVATE_PASSWORD_CONTENT_CANARY';
  const app = express(); app.use(requestTelemetry(record => records.push(record)));
  app.get('/work/:id', async (req, res) => {
    await measure('generation', async () => {
      emit('stage_completed', { stage: 'database', password: canary, question: canary, error: new Error(canary), route: canary + '?' });
      await new Promise(resolve => setTimeout(resolve, req.params.id === 'slow' ? 40 : 5));
    });
    res.json({ id: traceId() });
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const responses = await Promise.all(['slow', canary].map(id => fetch(`${base}/work/${id}?password=${canary}`, { headers: { Authorization: canary, 'X-Request-ID': canary } })));
    const ids = await Promise.all(responses.map(async response => { const body = await response.json(); assert.equal(body.id, response.headers.get('x-request-id')); return body.id; }));
    assert.equal(new Set(ids).size, 2);
    for (const id of ids) {
      const trace = records.filter(record => record.requestId === id);
      assert.equal(trace.filter(record => record.event === 'http_completed').length, 1);
      assert.ok(trace.some(record => record.stage === 'generation' && record.outcome === 'ok'));
    }
    assert.ok(records.filter(record => record.event === 'http_completed').every(record => record.route === '/work/:id'));
    assert.equal(JSON.stringify(records).includes(canary), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('failed jobs keep a safe stage/attempt and legacy jobs get a fresh trace without raw exceptions', async () => {
  const records = [], org = randomUUID(), doc = randomUUID(), failure = new Error('PRIVATE_FAILURE');
  await assert.rejects(withJobTrace({ organizationId: org, documentId: doc }, 'bad job secret', () => measure('extraction', async () => { throw failure; }), record => records.push(record), 3), error => error === failure);
  assert.ok(records.every(record => record.organizationId === org && record.documentId === doc && record.attempt === 3 && record.jobId === 'invalid-job'));
  assert.ok(records.some(record => record.stage === 'worker' && record.outcome === 'failed'));
  assert.equal(new Set(records.map(record => record.requestId)).size, 1);
  assert.equal(JSON.stringify(records).includes('PRIVATE_FAILURE'), false);
});

test('an unavailable log sink cannot fail or repeat the wrapped operation', async () => {
  let calls = 0;
  const result = await withJobTrace({ organizationId: randomUUID(), documentId: randomUUID() }, 'fixture', async () => { calls++; return 'done'; }, () => { throw new Error('Sink unavailable'); });
  assert.equal(result, 'done'); assert.equal(calls, 1);
});
