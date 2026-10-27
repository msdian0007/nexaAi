// Real API, PostgreSQL, Redis, queue and worker. The fixture controls only local
// inference/provider output; all diagnosis assertions use captured safe records.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startAgentFixture } = require('./helpers/agent.http-fixture.cjs');
const { createDocumentWorker } = require('../dist/src/document/document.worker');

test('Phase 15 traces, authorized operations, atomic audit and failed-job diagnosis', { timeout: 120000 }, async t => {
  const records = [], f = await startAgentFixture({ fullApi: true, logSink: record => records.push(record) });
  const token = f.token(), canary = 'PRIVATE_CONTENT_PASSWORD_STORAGE_CANARY';
  const context = f.context;
  let worker, running;
  async function call(route, method = 'GET', body, credential = token) {
    const response = await fetch(f.baseUrl + route, { method, headers: { Authorization: `Bearer ${credential}`,
      Origin: 'http://127.0.0.1:4173', 'X-Request-ID': canary, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const requestId = response.headers.get('x-request-id');
    assert.match(requestId, /^[0-9a-f-]{36}$/); assert.notEqual(requestId, canary);
    return { status: response.status, requestId, body: await response.json() };
  }
  async function owner() { await f.prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'OWNER' } }); }
  try {
    await t.test('liveness and dependency readiness are separate; current membership controls operations', async () => {
      assert.equal((await call('/health/live')).status, 200);
      assert.equal((await call('/health/ready')).status, 200);
      assert.equal((await call('/operations/summary')).status, 403);
      assert.equal((await call('/operations/audit')).status, 403);
      await owner();
      const result = await call('/operations/summary'); assert.equal(result.status, 200);
      assert.equal(result.body.data.workersAvailable, false);
      assert.ok(result.body.data.alerts.includes('NO_DOCUMENT_WORKER'));
      assert.equal(result.body.data.totalDocuments, 2);
    });
    await t.test('profile change and its metadata-only audit share request ID and transaction', async () => {
      const result = await call('/organizations/profile', 'PATCH', { name: canary }); assert.equal(result.status, 200);
      const list = await call('/operations/audit'); assert.equal(list.status, 200);
      const event = list.body.data.events.find(event => event.action === 'ORGANIZATION_UPDATED');
      assert.equal(event.requestId, result.requestId); assert.equal(event.actorId, context.userId);
      assert.equal(event.targetId, context.organizationId); assert.equal(JSON.stringify(event).includes(canary), false);
      const originalTransaction = f.prisma.$transaction;
      f.prisma.$transaction = (work, options) => originalTransaction.call(f.prisma, async tx => {
        const original = tx.auditEvent.create;
        tx.auditEvent.create = async () => { throw new Error(canary); };
        try { return await work(tx); } finally { tx.auditEvent.create = original; }
      }, options);
      try { assert.equal((await call('/organizations/profile', 'PATCH', { name: 'Must roll back' })).status, 500); }
      finally { f.prisma.$transaction = originalTransaction; }
      assert.equal((await f.prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId } })).name, canary);
      assert.equal(await f.prisma.auditEvent.count({ where: { organizationId: context.organizationId } }), 1);
    });
    await t.test('audit pages are bounded and private; there is no audit mutation API', async () => {
      await f.prisma.auditEvent.createMany({ data: Array.from({ length: 23 }, () => ({ id: randomUUID(), organizationId: context.organizationId,
        actorId: context.userId, action: 'MEMBER_ADDED', targetId: randomUUID() })) });
      const first = await call('/operations/audit'); assert.equal(first.body.data.events.length, 20);
      const second = await call('/operations/audit?cursor=' + first.body.data.nextCursor); assert.equal(second.body.data.events.length, 4);
      assert.equal(new Set([...first.body.data.events, ...second.body.data.events].map(e => e.id)).size, 24);
      const other = await call('/operations/audit', 'GET', undefined, f.token(f.outsider, f.foreign)); assert.deepEqual(other.body.data.events, []);
      assert.equal((await call('/operations/audit?cursor=' + first.body.data.nextCursor, 'GET', undefined, f.token(f.outsider, f.foreign))).status, 404);
      assert.equal((await call('/operations/audit', 'POST', { action: 'FORGED' })).status, 404);
      assert.equal((await call('/operations/audit?organizationId=' + f.foreign)).status, 400);
    });
    await t.test('request -> job -> failed extraction -> worker attempt can be traced without file content/path', async () => {
      const document = f.documents[1];
      await f.prisma.document.update({ where: { id: document.id }, data: { storagePath: path.resolve('uploads', 'documents', context.organizationId, canary + '.txt') } });
      const response = await call(`/documents/${document.id}/reprocess`, 'POST'); assert.equal(response.status, 202);
      const jobId = `document-${context.organizationId}-${document.id}`;
      assert.equal((await f.inspector.getJob(jobId)).data.requestId, response.requestId);
      worker = createDocumentWorker({ queueName: f.inspector.name, logSink: record => records.push(record) });
      running = worker.run();
      const deadline = Date.now() + 30000;
      while (await (await f.inspector.getJob(jobId)).getState() !== 'failed') {
        assert.ok(Date.now() < deadline, 'Fixture worker did not reach failed state');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const trace = records.filter(record => record.requestId === response.requestId);
      assert.ok(trace.some(record => record.event === 'job_submitted' && record.jobId === jobId));
      assert.ok(trace.some(record => record.stage === 'extraction' && record.outcome === 'failed' && record.documentId === document.id));
      assert.equal(trace.filter(record => record.stage === 'worker').length, 3);
      assert.deepEqual(trace.filter(record => record.stage === 'worker').map(record => record.attempt), [1, 2, 3]);
      assert.ok(trace.every(record => record.durationMs === undefined || record.durationMs >= 0));
      const summary = await call('/operations/summary');
      assert.equal(summary.body.data.workersAvailable, true);
      assert.equal(summary.body.data.states.failed, 1); assert.ok(summary.body.data.alerts.includes('QUEUE_FAILURES'));
      assert.equal(JSON.stringify(records).includes(canary), false); assert.equal(JSON.stringify(records).includes(token), false);
      assert.match(response.requestId, /^[0-9a-f-]{36}$/);
    });
    await t.test('demotion during queue inspection withholds metrics; outages expose no raw exception', async () => {
      const original = f.app.locals.getDocumentQueue;
      f.app.locals.getDocumentQueue = async () => ({ ...f.producer, checkConnection: async () => {
        await f.prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'MEMBER' } }); return true;
      } });
      try { assert.equal((await call('/operations/summary')).status, 403); }
      finally { f.app.locals.getDocumentQueue = original; await owner(); }
      f.app.locals.getDocumentQueue = async () => ({ ...f.producer, workerCount: async () => { throw new Error(canary); } });
      try {
        const summary = await call('/operations/summary'); assert.equal(summary.status, 200);
        assert.equal(summary.body.data.workersAvailable, null);
        assert.ok(summary.body.data.alerts.includes('WORKER_STATUS_UNAVAILABLE'));
        assert.equal(summary.body.data.alerts.includes('NO_DOCUMENT_WORKER'), false);
      } finally { f.app.locals.getDocumentQueue = original; }
      f.app.locals.getDocumentQueue = async () => { throw new Error(canary); };
      try {
        const summary = await call('/operations/summary'); assert.equal(summary.status, 200);
        assert.ok(summary.body.data.alerts.includes('QUEUE_UNAVAILABLE')); assert.equal(JSON.stringify(summary.body).includes(canary), false);
        assert.equal((await call('/health/ready')).status, 503); assert.equal((await call('/health/live')).status, 200);
      } finally { f.app.locals.getDocumentQueue = original; }
    });
    await t.test('retention defaults to dry-run and does not delete old fixture records', async () => {
      const old = await f.prisma.auditEvent.create({ data: { organizationId: context.organizationId, actorId: context.userId,
        action: 'MEMBER_REMOVED', targetId: randomUUID(), createdAt: new Date(Date.now() - 95 * 86400000) } });
      const output = JSON.parse(execFileSync(process.execPath, ['scripts/retention.cjs'], { encoding: 'utf8' }));
      assert.equal(output.mode, 'dry_run'); assert.ok(output.auditEvents >= 1);
      assert.ok(await f.prisma.auditEvent.findUnique({ where: { id: old.id } }));
    });
  } finally {
    if (worker) { await worker.close(); await running; }
    await f.stop();
  }
});
