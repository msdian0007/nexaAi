// Real Redis + PostgreSQL + production app. Each counter has a private namespace;
// cleanup deletes only exact matching fixture keys, never shared queue data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const prisma = require('../dist/src/config/database').default;
const { createRedisConnection } = require('../dist/src/config/redis');
const { createAdmissionStore, usageBudgets } = require('../dist/src/http/usage.admission');
const { createApiApp } = require('../dist/src/api');
const { issueAuthToken } = require('../dist/src/auth/auth.tokens');

test('shared admission counters and production API limits', { timeout: 120000 }, async t => {
  const prefix = `test-admission-${randomUUID()}`;
  const store = createAdmissionStore({ prefix }), second = createAdmissionStore({ prefix });
  const unavailable = createAdmissionStore({ prefix, url: 'redis://127.0.0.1:1' });
  const redis = createRedisConnection();
  const user = randomUUID(), peer = randomUUID(), outsider = randomUUID(), org = randomUUID(), foreign = randomUUID();
  const users = [user, peer, outsider], organizations = [org, foreign];
  const priorSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  const budgets = { aiOrganization: 500, aiApplication: 2000, documentsOrganization: 100 };
  let failStore = false, queueCalls = 0, server;
  const nativeFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async (input, options) => {
    if (String(input).startsWith('https://generativelanguage.googleapis.com/')) {
      providerCalls++;
      throw new Error('No provider request is allowed in admission tests');
    }
    return nativeFetch(input, options);
  };
  const json = body => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  async function clearCounters() {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
      cursor = next;
      assert.ok(keys.every(key => key.startsWith(`${prefix}:`)));
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  }
  const fill = async (key, limit, windowMs = 60000) => {
    for (let i = 0; i < limit; i++) assert.equal(await store.consume([{ key, limit, windowMs }]), 0);
  };
  try {
    await redis.connect();
    for (const id of organizations) await prisma.organization.create({ data: { id, name: 'Admission fixture', slug: `admission-${id}` } });
    for (const id of users) await prisma.user.create({ data: { id, name: 'Admission fixture', email: `${id}@example.invalid`, password: 'unused-fixture-hash' } });
    for (const [userId, organizationId] of [[user, org], [peer, org], [outsider, foreign]]) await prisma.organizationMember.create({ data: { userId, organizationId, role: 'OWNER' } });
    const token = id => issueAuthToken({ userId: id, organizationId: id === outsider ? foreign : org, role: 'OWNER' }).token;
    const tokens = Object.fromEntries(users.map(id => [id, token(id)]));
    const app = createApiApp({ origins: ['http://127.0.0.1:4173'], usageBudgets: budgets,
      admissionStore: { consume: rules => (failStore ? unavailable : store).consume(rules) } });
    app.locals.getDocumentQueue = async () => { queueCalls++; throw new Error('Queue must not be reached'); };
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function call(route, options = {}, id = user) {
      const response = await fetch(base + route, { ...options, headers: { Authorization: `Bearer ${tokens[id]}`, ...options.headers }, signal: AbortSignal.timeout(15000) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
    async function denied(route, options = json({}), id = user) {
      const result = await call(route, options, id);
      assert.equal(result.status, 429); assert.equal(result.body.code, 'RATE_LIMITED');
      assert.ok(result.body.retryAfterSeconds >= 1 && result.body.retryAfterSeconds <= 86400);
      assert.equal(Number(result.headers.get('retry-after')), result.body.retryAfterSeconds);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      return result;
    }
    await t.test('budgets have safe defaults and reject zero, invalid, oversized and secret-like configuration', () => {
      assert.deepEqual(usageBudgets({}), { aiOrganization: 500, aiApplication: 2000, documentsOrganization: 100 });
      assert.equal(usageBudgets({ USAGE_AI_ORG_DAILY_LIMIT: '25' }).aiOrganization, 25);
      for (const value of ['0', '-1', '1.5', '1000001', '', 'redis://private']) assert.throws(() => usageBudgets({ USAGE_AI_APP_DAILY_LIMIT: value }), error => !error.message.includes(value === '' ? 'redis://' : value));
    });
    await t.test('two Redis clients race for ten slots; exactly ten requests are admitted', async () => {
      const rules = [{ key: 'race', limit: 10, windowMs: 60000 }];
      const results = await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? store : second).consume(rules)));
      assert.equal(results.filter(value => value === 0).length, 10);
      assert.ok(results.filter(value => value > 0).every(value => value <= 60));
    });
    await t.test('rejecting one exhausted counter does not charge another or extend the wait', async () => {
      await fill('full', 1, 10000);
      const rules = [{ key: 'full', limit: 1, windowMs: 10000 }, { key: 'untouched', limit: 1, windowMs: 10000 }];
      assert.ok(await store.consume(rules) > 0);
      assert.equal(await second.consume([{ key: 'untouched', limit: 1, windowMs: 10000 }]), 0);
      const keys = await redis.keys(`${prefix}:*`);
      for (const key of keys) assert.ok(await redis.pttl(key) > 0);
    });
    await t.test('a short real TTL expires and grants a fresh allowance', async () => {
      const rules = [{ key: 'expiry', limit: 1, windowMs: 80 }];
      assert.equal(await store.consume(rules), 0); assert.ok(await second.consume(rules) > 0);
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(await second.consume(rules), 0);
    });
    await t.test('stored keys contain no raw identifiers and survive closing/recreating the API connection', async () => {
      await fill(`private:${user}:person@example.invalid`, 1);
      const keys = await redis.keys(`${prefix}:*`);
      assert.ok(keys.every(key => /^\w[\w-]*:[a-f0-9]{64}$/.test(key) && !key.includes(user) && !key.includes('@')));
      await second.close();
      assert.ok(await second.consume([{ key: `private:${user}:person@example.invalid`, limit: 1, windowMs: 60000 }]) > 0);
    });
    await clearCounters();
    await t.test('login and registration share peer limits; forged forwarded IPs cannot reset them', async () => {
      for (let i = 0; i < 20; i++) assert.equal((await call('/auth/login', json({}))).status, 400);
      for (const route of ['/auth/login', '/auth/register', '/auth/register-invitation'])
        await denied(route, { ...json({ email: `${user}@example.invalid`, password: 'example-password' }), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${Math.floor(Math.random() * 200)}` } });
      assert.equal(await prisma.user.count({ where: { id: { in: users } } }), 3);
    });
    await clearCounters();
    await t.test('Chat, search and agent requests share the user allowance across signed sessions', async () => {
      await fill(`ai:user:${user}`, 20);
      // Issue another token: counters use the verified user, not the session token.
      tokens[user] = token(user);
      for (const route of ['/chat/query', '/documents/search', '/agents/requests']) {
        await denied(route, json(route.includes('agents') ? { message: 'Count documents' } : { question: 'What is the policy?', query: 'policy' }));
      }
      const corsDenied = await denied('/CHAT/QUERY/', { ...json({ question: 'policy' }), headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4173' } });
      assert.match(corsDenied.headers.get('access-control-expose-headers'), /Retry-After/i);
      await prisma.organizationMember.create({ data: { userId: user, organizationId: foreign, role: 'MEMBER' } });
      const originalToken = tokens[user];
      tokens[user] = issueAuthToken({ userId: user, organizationId: foreign, role: 'MEMBER' }).token;
      await denied('/chat/query', json({ question: 'policy' }));
      tokens[user] = originalToken;
      assert.equal((await call('/chat/query', json({}), peer)).status, 400);
      assert.equal((await call('/chat/query', json({}), outsider)).status, 400);
      assert.equal(await prisma.agentExecution.count({ where: { organizationId: org } }), 0);
      assert.equal(await prisma.conversation.count({ where: { organizationId: org } }), 0);
      assert.equal(providerCalls, 0);
    });
    await clearCounters();
    await t.test('organization minute allowance also blocks a teammate with an unused personal allowance', async () => {
      await fill(`ai:org:minute:${org}`, 60);
      await denied('/chat/query', json({ question: 'policy' }), peer);
      assert.equal((await call('/chat/query', json({}), outsider)).status, 400);
      assert.equal(providerCalls, 0);
    });
    await clearCounters();
    await t.test('teammates share the organization daily budget; other organizations remain independent', async () => {
      budgets.aiOrganization = 1;
      assert.equal((await call('/chat/query', json({}))).status, 400);
      await denied('/agents/requests', json({ message: 'Count documents' }), peer);
      assert.equal((await call('/chat/query', json({}), outsider)).status, 400);
      budgets.aiOrganization = 500;
    });
    await clearCounters();
    await t.test('application daily AI budget spans organizations', async () => {
      budgets.aiApplication = 1;
      assert.equal((await call('/chat/query', json({}))).status, 400);
      await denied('/documents/search', json({ query: 'policy' }), outsider);
      budgets.aiApplication = 2000;
    });
    await clearCounters();
    await t.test('uploads, direct retries and agent confirmations share admission before disk/database/queue writes', async () => {
      await fill(`documents:user:${user}`, 5);
      const body = new FormData(); body.append('document', new Blob(['private fixture bytes'], { type: 'text/plain' }), 'policy.txt');
      await denied('/documents/upload', { method: 'POST', body });
      await denied(`/documents/${randomUUID()}/reprocess`);
      await denied(`/agents/proposals/${randomUUID()}/confirm`);
      assert.equal(queueCalls, 0);
      assert.equal(providerCalls, 0);
      assert.equal(await prisma.document.count({ where: { organizationId: org } }), 0);
      assert.equal(await prisma.agentExecution.count({ where: { organizationId: org } }), 0);
      await assert.rejects(fs.stat(path.resolve('uploads', 'documents', org)), { code: 'ENOENT' });
    });
    await clearCounters();
    await t.test('document processing daily budget is shared by teammates', async () => {
      budgets.documentsOrganization = 1;
      assert.equal((await call(`/documents/${randomUUID()}/reprocess`, json({ extra: true }))).status, 400);
      await denied(`/agents/proposals/${randomUUID()}/confirm`, json({}), peer);
      budgets.documentsOrganization = 100;
    });
    await clearCounters();
    await t.test('missing identity and removed membership are rejected before spending organization allowance', async () => {
      const invalid = await call('/chat/query', { ...json({}), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid' } });
      assert.equal(invalid.status, 401);
      await prisma.organizationMember.delete({ where: { userId_organizationId: { userId: user, organizationId: org } } });
      const removed = await call('/chat/query', json({}));
      assert.equal(removed.status, 403); assert.equal(removed.body.code, 'MEMBERSHIP_REQUIRED');
      assert.deepEqual(await redis.keys(`${prefix}:*`), []);
      await prisma.organizationMember.create({ data: { userId: user, organizationId: org, role: 'OWNER' } });
    });
    await t.test('limiter failure denies costly routes safely but leaves reads, workspace recovery and logout available', async () => {
      failStore = true;
      for (const route of ['/chat/query', '/documents/search', '/agents/requests', '/documents/upload', `/documents/${randomUUID()}/reprocess`, `/agents/proposals/${randomUUID()}/confirm`, '/auth/login']) {
        const result = await call(route, json({}));
        assert.equal(result.status, 503); assert.equal(result.body.code, 'USAGE_UNAVAILABLE');
        assert.equal(JSON.stringify(result.body).includes('PRIVATE'), false);
      }
      for (const route of ['/auth/me', '/auth/organizations', '/chat/conversations', '/agents/executions', '/health']) assert.equal((await call(route)).status, 200, route);
      assert.equal((await call('/auth/logout', json({}))).status, 200);
      assert.equal(queueCalls, 0);
      failStore = false;
      assert.equal((await call('/chat/query', json({}), peer)).status, 400);
    });
  } finally {
    global.fetch = nativeFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    if (redis.status === 'ready') await clearCounters();
    await Promise.all([store.close(), second.close(), unavailable.close()]); redis.disconnect();
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
    await prisma.$disconnect();
  }
});
