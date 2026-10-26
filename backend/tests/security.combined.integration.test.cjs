// Shipped app + JWTs + PostgreSQL + scoped Redis admission/queue + warm cache.
// Only local embeddings/Gemini output are controlled; no live provider quota.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { startAgentFixture } = require('./helpers/agent.http-fixture.cjs');

test('combined security gate protects cached reads, current roles, confirmed writes and recovery', { timeout: 120000 }, async t => {
  const f = await startAgentFixture({ fullApi: true });
  let active = f.token();
  const question = 'What is our leave policy?';
  const context = f.context;
  async function call(route, { method = 'GET', body, token = active, headers = {} } = {}) {
    const response = await fetch(f.baseUrl + route, { method, headers: { Origin: 'http://127.0.0.1:4173',
      Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const search = () => call('/documents/search', { method: 'POST', body: { query: question } });
  const ask = message => call('/agents/requests', { method: 'POST', body: { message } });
  const snapshot = async () => ({ ...f.calls, inferences: f.inferences(),
    executions: await f.prisma.agentExecution.count({ where: context }),
    messages: await f.prisma.message.count({ where: { organizationId: context.organizationId } }),
    waiting: await f.inspector.getWaitingCount() });
  // Scenarios share warm application state but reset only fixture-owned counters
  // between them. No flush touches a developer's limits or document queue.
  const scenario = (name, work) => t.test(name, async () => { await f.clearAllowances(); await work(); });
  async function loginOwn() {
    const login = await call('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } });
    assert.equal(login.status, 200);
    const switched = await call('/auth/switch-organization', { method: 'POST', token: login.body.data.token, body: { organizationId: context.organizationId } });
    assert.equal(switched.status, 200); active = switched.body.data.token;
  }
  try {
    await scenario('actual password login warms an organization cache without bypassing the production boundary', async () => {
      await loginOwn();
      assert.equal((await call('/auth/me')).body.data.role, 'MEMBER');
      for (let i = 0; i < 2; i++) {
        const result = await search(); assert.equal(result.status, 200);
        assert.equal(result.body.data.results[0].documentId, f.documents[0].id);
        assert.equal(result.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
      }
      assert.equal(f.inferences(), 1); assert.equal(f.calls.answer, 0);
    });
    await scenario('expired and incorrectly signed credentials cannot read a warm cache', async () => {
      const before = await snapshot();
      const identity = { ...context, role: 'OWNER' };
      const expired = jwt.sign({ ...identity, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.JWT_SECRET);
      const forged = jwt.sign(identity, randomUUID(), { expiresIn: '5m' });
      for (const [token, code] of [[expired, 'SESSION_EXPIRED'], [forged, 'INVALID_SESSION']]) {
        const result = await call('/documents/search', { method: 'POST', token, body: { query: question } });
        assert.equal(result.status, 401); assert.equal(result.body.code, code);
      }
      assert.deepEqual(await snapshot(), before);
    });
    await scenario('foreign IDs, context overrides and hostile origins fail without exposing data', async () => {
      const foreignId = f.documents[2].id;
      assert.equal((await call(`/documents/${foreignId}/status`)).status, 404);
      // Members have no delete permission, so both foreign and missing IDs are
      // denied before lookup. An authorized admin must still be tenant-scoped.
      assert.equal((await call(`/documents/${foreignId}`, { method: 'DELETE' })).status, 403);
      assert.equal((await call(`/documents/${randomUUID()}`, { method: 'DELETE' })).status, 403);
      await f.prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'ADMIN' } });
      try { assert.equal((await call(`/documents/${foreignId}`, { method: 'DELETE' })).status, 404); }
      finally { await f.prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'MEMBER' } }); }
      assert.equal((await call(`/documents/${foreignId}/reprocess`, { method: 'POST' })).status, 404);
      assert.equal((await ask(`Retry ${foreignId}`)).status, 404);
      const before = await snapshot();
      assert.equal((await call('/documents/search', { method: 'POST', body: { query: question, organizationId: f.foreign } })).status, 400);
      assert.equal((await call('/agents/requests', { method: 'POST', body: { message: 'Count documents', confirmed: true } })).status, 400);
      const blocked = await call('/documents/search', { method: 'POST', body: { query: question }, headers: { Origin: 'https://hostile.example.invalid' } });
      assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'ORIGIN_NOT_ALLOWED');
      assert.deepEqual(await snapshot(), before);
      assert.equal((await f.prisma.document.findUniqueOrThrow({ where: { id: foreignId } })).status, 'FAILED');
    });
    await scenario('an old OWNER claim cannot override the current role; promotion and demotion take effect', async () => {
      const staleOwner = f.token();
      assert.equal((await call('/auth/admin-test', { token: staleOwner })).status, 403);
      assert.equal((await call('/organizations/profile', { method: 'PATCH', token: staleOwner, body: { name: 'Unauthorized rename' } })).status, 403);
      await f.prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'ADMIN' } });
      assert.equal((await call('/auth/admin-test', { token: staleOwner })).status, 200);
      await f.prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'MEMBER' } });
      assert.equal((await call('/auth/admin-test', { token: staleOwner })).status, 403);
    });
    await scenario('private confirmation, racing clicks and replay produce only one real queue submission', async () => {
      const proposed = await ask(`Retry ${f.documents[1].id}`);
      assert.equal(proposed.status, 200);
      const proposal = proposed.body.data.result.proposal;
      const confirm = `/agents/proposals/${proposal.id}/confirm`;
      assert.equal(await f.inspector.getWaitingCount(), 0);
      assert.equal((await call(confirm, { method: 'POST', token: f.token(f.peer) })).status, 404);
      assert.equal((await call(confirm, { method: 'POST', token: f.token(f.outsider, f.foreign) })).status, 404);
      assert.equal((await call(confirm, { method: 'POST', body: { documentId: f.documents[2].id, confirmed: true } })).status, 400);
      await f.clearAllowances();
      const results = await Promise.all([call(confirm, { method: 'POST' }), call(confirm, { method: 'POST' })]);
      assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);
      assert.equal((await call(confirm, { method: 'POST' })).status, 409);
      assert.equal(await f.inspector.getWaitingCount(), 1);
      assert.equal((await f.prisma.agentRetryProposal.findUniqueOrThrow({ where: { id: proposal.id } })).state, 'ACCEPTED');
    });
    await scenario('membership removal during a cached question withholds the generated exchange', async () => {
      const beforeMessages = await f.prisma.message.count({ where: { organizationId: context.organizationId } });
      f.controls.answer = async () => {
        await f.prisma.organizationMember.delete({ where: { userId_organizationId: context } });
        return JSON.stringify({ status: 'answered', answer: 'Employees receive 18 days [S1].', citations: ['S1'] });
      };
      try {
        const result = await call('/chat/query', { method: 'POST', body: { question } });
        assert.equal(result.status, 403); assert.equal(result.body.data, undefined);
        assert.equal(f.inferences(), 1);
        assert.equal(await f.prisma.message.count({ where: { organizationId: context.organizationId } }), beforeMessages);
      } finally {
        f.controls.answer = undefined;
        await f.prisma.organizationMember.create({ data: { ...context, role: 'MEMBER' } });
      }
    });
    await scenario('removed membership can recover through workspace switch and sign-out without exposing cached passages', async () => {
      await f.prisma.organizationMember.create({ data: { userId: context.userId, organizationId: f.foreign, role: 'MEMBER' } });
      await f.prisma.organizationMember.delete({ where: { userId_organizationId: context } });
      const old = active;
      try {
        assert.equal((await search()).status, 403);
        assert.equal((await call('/auth/me')).body.code, 'ORGANIZATION_ACCESS_REVOKED');
        assert.equal((await call('/auth/organizations')).status, 200);
        const switched = await call('/auth/switch-organization', { method: 'POST', body: { organizationId: f.foreign } });
        assert.equal(switched.status, 200);
        const recovered = switched.body.data.token;
        assert.equal((await call(`/documents/${f.documents[0].id}/status`, { token: recovered })).status, 404);
        assert.equal((await call('/auth/logout', { method: 'POST', token: old })).status, 200);
        const replay = await call('/documents/search', { method: 'POST', token: old, body: { query: question } });
        assert.equal(replay.status, 401); assert.equal(replay.body.code, 'SESSION_REVOKED');
        await f.prisma.organizationMember.create({ data: { ...context, role: 'MEMBER' } });
        const back = await call('/auth/switch-organization', { method: 'POST', token: recovered, body: { organizationId: context.organizationId } });
        assert.equal(back.status, 200); active = back.body.data.token;
      } finally {
        await f.prisma.organizationMember.upsert({ where: { userId_organizationId: context }, create: { ...context, role: 'MEMBER' }, update: {} });
      }
      assert.equal((await search()).status, 200); assert.equal(f.inferences(), 1);
    });
    await scenario('real Redis allowance exhaustion blocks warm search, Chat and agent work without extra side effects', async () => {
      for (let i = 0; i < 20; i++) assert.equal(await f.allowances.consume([{ key: `ai:user:${context.userId}`, limit: 20, windowMs: 60000 }]), 0);
      const before = await snapshot();
      for (const [route, body] of [['/documents/search', { query: question }], ['/chat/query', { question }], ['/agents/requests', { message: question }]]) {
        const result = await call(route, { method: 'POST', body });
        assert.equal(result.status, 429); assert.equal(result.body.code, 'RATE_LIMITED');
        assert.ok(Number(result.headers.get('retry-after')) >= 1);
      }
      assert.deepEqual(await snapshot(), before);
    });
    await scenario('an admission connection failure stops writes but permits reads/logout, then recovers', async () => {
      f.controls.admissionUnavailable = true;
      const before = await snapshot();
      try {
        for (const [route, body] of [['/documents/search', { query: question }], ['/chat/query', { question }], ['/agents/requests', { message: question }], [`/agents/proposals/${randomUUID()}/confirm`, undefined]]) {
          const result = await call(route, { method: 'POST', body });
          assert.equal(result.status, 503); assert.equal(result.body.code, 'USAGE_UNAVAILABLE');
        }
        assert.deepEqual(await snapshot(), before);
        for (const route of ['/auth/me', '/chat/conversations', '/agents/executions', `/documents/${f.documents[1].id}/status`, '/health']) assert.equal((await call(route)).status, 200);
        assert.equal((await call('/auth/logout', { method: 'POST' })).status, 200);
        assert.equal((await search()).body.code, 'SESSION_REVOKED');
      } finally { f.controls.admissionUnavailable = false; }
      await loginOwn();
      assert.equal((await search()).status, 200); assert.equal(f.inferences(), 1);
    });
  } finally { await f.stop(); }
});
