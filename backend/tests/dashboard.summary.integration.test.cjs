// Real PostgreSQL + actual HTTP router; no Gemini, Redis or browser required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const { getDashboardSummary } = require('../dist/src/analytics/dashboard.service');
const { default: routes, dashboardJsonError } = require('../dist/src/analytics/dashboard.routes');

test('dashboard summary privacy, metric accuracy, HTTP and database guarantees', { timeout: 90000 }, async t => {
  const org = randomUUID(), foreign = randomUUID(), empty = randomUUID();
  const user = randomUUID(), peer = randomUUID();
  const context = { userId: user, organizationId: org };
  const query = { from: '2026-10-24', to: '2026-10-27' };
  const originalTransaction = prisma.$transaction;
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  let server;
  let conversation;
  const date = value => new Date(`${value}Z`);
  async function document(organizationId, createdAt, status = 'UPLOADED', deleting = false) {
    return prisma.document.create({ data: { organizationId, uploadedById: peer,
      name: 'private-name', originalName: 'private.txt', storagePath: 'private/path',
      mimeType: 'text/plain', size: 3, extractedText: 'private content', status,
      createdAt: date(createdAt), deletionRequestedAt: deleting ? new Date() : null } });
  }
  async function execution(userId, organizationId, startedAt, outcome = 'SUCCEEDED', operation = 'REQUEST') {
    return prisma.agentExecution.create({ data: { userId, organizationId,
      startedAt: date(startedAt), outcome, operation } });
  }
  // Intercept one boundary while retaining real isolation, reads and SQL controls.
  async function intercept(hook, run) {
    prisma.$transaction = (work, options) => originalTransaction.call(prisma, tx => work({
      $executeRaw: tx.$executeRaw.bind(tx), $queryRaw: tx.$queryRaw.bind(tx),
      organizationMember: tx.organizationMember, agentExecution: tx.agentExecution,
      document: { groupBy: args => hook(tx, args) },
    }), options);
    try { return await run(); } finally { prisma.$transaction = originalTransaction; }
  }
  try {
    for (const id of [org, foreign, empty]) await prisma.organization.create({ data: { id, name: 'Dashboard fixture', slug: `dashboard-${id}` } });
    for (const id of [user, peer]) await prisma.user.create({ data: { id, name: 'Fixture', email: `${id}@example.invalid`, password: 'unused' } });
    for (const [userId, organizationId] of [[user, org], [peer, org], [peer, foreign], [user, empty], [user, foreign]])
      await prisma.organizationMember.create({ data: { userId, organizationId, role: 'MEMBER' } });
    await document(org, '2026-10-23T23:59:59.999', 'COMPLETED');
    await document(org, '2026-10-25T00:00:00', 'FAILED');
    await document(org, '2026-10-26T23:59:59.999');
    await document(org, '2026-10-25T12:00:00', 'FAILED', true);
    await document(foreign, '2026-10-25T12:00:00', 'PROCESSING');
    for (const [userId, organizationId] of [[user, org], [peer, org], [user, foreign]]) {
      const c = await prisma.conversation.create({ data: { userId, organizationId, title: 'private title', createdAt: date('2026-10-01T00:00:00') } });
      if (userId === user && organizationId === org) conversation = c;
      for (const [i, createdAt] of ['2026-10-23T23:59:59.999', '2026-10-25T00:00:00', '2026-10-26T23:59:59.999', '2026-10-27T00:00:00'].entries()) {
        await prisma.message.create({ data: { conversationId: c.id, organizationId, role: 'USER', content: 'private question', sequence: i * 2, createdAt: date(createdAt) } });
        await prisma.message.create({ data: { conversationId: c.id, organizationId, role: 'ASSISTANT', content: 'private answer', answerStatus: 'insufficient_information', sequence: i * 2 + 1, createdAt: date(createdAt) } });
      }
      for (const [i, outcome] of ['SUCCEEDED', 'FAILED', 'STARTED', 'UNCONFIRMED'].entries())
        await execution(userId, organizationId, i === 0 ? '2026-10-25T00:00:00' : '2026-10-26T23:59:59.999', outcome);
      await execution(userId, organizationId, '2026-10-23T23:59:59.999');
      await execution(userId, organizationId, '2026-10-27T00:00:00');
      await execution(userId, organizationId, '2026-10-25T12:00:00', 'SUCCEEDED', 'CONFIRM');
      await execution(userId, organizationId, '2026-10-25T12:00:00', 'SUCCEEDED', 'CANCEL');
    }
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.use('/api/v1/analytics', routes, dashboardJsonError);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1/analytics/summary`;
    // Deliberately stale OWNER claim: current membership controls access.
    const token = jwt.sign({ ...context, role: 'OWNER' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    async function http(suffix = '', auth = token) {
      const res = await fetch(base + suffix, { headers: auth ? { Authorization: `Bearer ${auth}` } : {}, signal: AbortSignal.timeout(15000) });
      assert.equal(res.headers.get('cache-control'), 'no-store');
      return { status: res.status, body: await res.json() };
    }
    let baseline;
    await t.test('exact shared/personal counts for every role with no peer content or IDs', async () => {
      for (const role of ['MEMBER', 'ADMIN', 'OWNER']) {
        await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role } });
        const result = await http('?from=2026-10-24&to=2026-10-27');
        assert.equal(result.status, 200);
        const data = result.body.data;
        assert.equal(data.definitionVersion, 1);
        assert.ok(Number.isFinite(Date.parse(data.asOf)));
        assert.deepEqual(data.range, { ...query, timezone: 'UTC', days: 3 });
        assert.deepEqual(data.currentDocuments, { scope: 'organization', total: 3, byStatus: { UPLOADED: 1, PROCESSING: 0, COMPLETED: 1, FAILED: 1 } });
        assert.deepEqual(data.personalActivity, { scope: 'current_user', savedChatQuestions: 2, agentRequests: { total: 4, byOutcome: { STARTED: 1, SUCCEEDED: 1, FAILED: 1, UNCONFIRMED: 1 } } });
        assert.deepEqual(data.daily, [
          { date: '2026-10-24', organizationUploads: 0, ownSavedChatQuestions: 0, ownAgentRequests: 0 },
          { date: '2026-10-25', organizationUploads: 1, ownSavedChatQuestions: 1, ownAgentRequests: 1 },
          { date: '2026-10-26', organizationUploads: 1, ownSavedChatQuestions: 1, ownAgentRequests: 3 },
        ]);
        for (const hidden of ['private', org, foreign, user, peer, conversation.id]) assert.equal(JSON.stringify(data).includes(hidden), false);
        baseline = data;
      }
    });
    await t.test('date changes affect activity but never current document cards', async () => {
      const result = await getDashboardSummary(context, { from: '2026-10-24', to: '2026-10-25' });
      assert.deepEqual(result.currentDocuments, baseline.currentDocuments);
      assert.equal(result.personalActivity.savedChatQuestions, 0);
      assert.equal(result.personalActivity.agentRequests.total, 0);
    });
    await t.test('default and maximum ranges zero-fill empty organizations', async () => {
      const actor = { userId: user, organizationId: empty };
      const result = await getDashboardSummary(actor, {});
      assert.equal(result.daily.length, 7);
      assert.equal(result.currentDocuments.total, 0);
      assert.ok(result.daily.every(d => d.organizationUploads + d.ownSavedChatQuestions + d.ownAgentRequests === 0));
      assert.equal((await getDashboardSummary(actor, { from: '2026-07-29', to: '2026-10-27' })).daily.length, 90);
    });
    await t.test('invalid query/identity is rejected before opening a transaction', async () => {
      let opened = 0;
      prisma.$transaction = () => { opened++; throw new Error('unexpected DB'); };
      try {
        for (const suffix of ['?organizationId=' + foreign, '?userId=' + peer, '?from=2026-10-25', '?from=2026-02-30&to=2026-03-01', '?from=2026-10-25&from=2026-10-26&to=2026-10-27'])
          assert.equal((await http(suffix)).status, 400);
        const bad = jwt.sign({ userId: 'bad', organizationId: org }, process.env.JWT_SECRET);
        assert.equal((await http('', bad)).status, 401);
        assert.equal((await http('', null)).status, 401);
        assert.equal(opened, 0);
      } finally { prisma.$transaction = originalTransaction; }
    });
    await t.test('GET bodies and malformed/oversized JSON get safe no-store errors', async () => {
      // Node fetch disallows GET bodies; the native HTTP client can exercise them.
      const httpClient = require('node:http');
      async function bodyRequest(body) {
        return new Promise((resolve, reject) => {
          const req = httpClient.request(base, { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
            let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'], body: JSON.parse(text) }));
          });
          req.on('error', reject); req.end(body);
        });
      }
      for (const [body, status] of [['{"userId":"forged"}', 400], ['[]', 400], ['{bad', 400], [JSON.stringify({ text: 'x'.repeat(2000) }), 413]]) {
        const result = await bodyRequest(body);
        assert.equal(result.status, status); assert.equal(result.cache, 'no-store');
        assert.equal(result.body.success, false);
        assert.equal(JSON.stringify(result).includes('SyntaxError'), false);
      }
    });
    await t.test('removed membership denies a valid stale token before aggregates', async () => {
      const actor = { userId: user, organizationId: empty };
      await prisma.organizationMember.delete({ where: { userId_organizationId: actor } });
      let aggregates = 0;
      await intercept(async () => { aggregates++; throw new Error('unexpected aggregate'); }, async () => {
        const stale = jwt.sign({ ...actor, role: 'OWNER' }, process.env.JWT_SECRET);
        assert.equal((await http('', stale)).status, 403);
      });
      assert.equal(aggregates, 0);
    });
    await t.test('all metrics share membership snapshot despite concurrent inserts', async () => {
      let addedDocument, addedExecution, addedMessage;
      try {
        await intercept(async (tx, args) => {
          addedDocument = await document(org, '2026-10-25T12:00:00');
          addedExecution = await execution(user, org, '2026-10-25T12:00:00');
          addedMessage = await prisma.message.create({ data: { organizationId: org, conversationId: conversation.id, role: 'USER', content: 'concurrent private', sequence: 100, createdAt: date('2026-10-25T12:00:00') } });
          return tx.document.groupBy(args);
        }, async () => {
          const result = await getDashboardSummary(context, query);
          assert.deepEqual(result.currentDocuments, baseline.currentDocuments);
          assert.deepEqual(result.personalActivity, baseline.personalActivity);
          assert.deepEqual(result.daily, baseline.daily);
        });
        const next = await getDashboardSummary(context, query);
        assert.equal(next.currentDocuments.total, 4);
        assert.equal(next.personalActivity.savedChatQuestions, 3);
        assert.equal(next.personalActivity.agentRequests.total, 5);
      } finally {
        if (addedDocument) await prisma.document.delete({ where: { id: addedDocument.id } });
        if (addedExecution) await prisma.agentExecution.delete({ where: { id: addedExecution.id } });
        if (addedMessage) await prisma.message.delete({ where: { id: addedMessage.id } });
      }
    });
    await t.test('read-only transaction rejects writes', async () => {
      await intercept(tx => tx.document.updateMany({ where: { organizationId: org }, data: { errorMessage: 'must-not-write' } }),
        () => assert.rejects(getDashboardSummary(context, query), /read.only/i));
      assert.equal(await prisma.document.count({ where: { organizationId: org, errorMessage: 'must-not-write' } }), 0);
    });
    await t.test('real statement timeout cancels a slow query without retry', async () => {
      let attempts = 0;
      await intercept(tx => { attempts++; return tx.$queryRaw`SELECT pg_sleep(10)`; },
        () => assert.rejects(getDashboardSummary(context, query), /timeout|expired|canceling statement/i));
      assert.equal(attempts, 1);
    });
    await t.test('database failure returns 503 without private errors or false zero data', async () => {
      await intercept(() => { throw new Error('private password SQL'); }, async () => {
        const result = await http();
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { success: false, code: 'DASHBOARD_UNAVAILABLE', message: 'Dashboard is unavailable. Please try again later.' });
      });
    });
    await t.test('retained-data semantics remove deleted questions from prior days', async () => {
      await prisma.conversation.delete({ where: { id: conversation.id } });
      const result = await getDashboardSummary(context, query);
      assert.equal(result.personalActivity.savedChatQuestions, 0);
      assert.deepEqual(result.currentDocuments, baseline.currentDocuments);
      assert.deepEqual(result.personalActivity.agentRequests, baseline.personalActivity.agentRequests);
    });
    await t.test('summary imports no provider, embeddings or Redis runtime', () => {
      const loaded = Object.keys(require.cache).map(p => p.replaceAll('\\', '/'));
      for (const suffix of ['/config/redis.js', '/document/document.embedding.js', '/rag/gemini.provider.js'])
        assert.equal(loaded.some(p => p.endsWith(suffix)), false);
    });
  } finally {
    prisma.$transaction = originalTransaction;
    if (server) await new Promise(resolve => server.close(resolve));
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    try {
      await prisma.organization.deleteMany({ where: { id: { in: [org, foreign, empty] } } });
      await prisma.user.deleteMany({ where: { id: { in: [user, peer] } } });
    } finally { await prisma.$disconnect(); }
  }
});
