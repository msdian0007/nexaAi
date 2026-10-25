// Actual HTTP, signed sessions and PostgreSQL fixtures; no AI or queue work.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const authRouter = require('../dist/src/auth/auth.protected.route').default;
const orgRouter = require('../dist/src/organization/organization.routes').default;
const { listConversations, readConversation } = require('../dist/src/conversation/conversation.history');
const { getDocumentStatus } = require('../dist/src/document/document.service');

test('organization switching issues a session for a current membership only', { timeout: 60000 }, async t => {
  const userId = randomUUID(), otherUserId = randomUUID();
  const organizations = [randomUUID(), randomUUID(), randomUUID()];
  const originalSecret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const id of [userId, otherUserId]) await prisma.user.create({ data: { id, name: 'Switch fixture', email: `${id}@example.invalid`, password: 'fixture' } });
    for (const [index, id] of organizations.entries()) await prisma.organization.create({ data: { id, name: `Switch team ${index}`, slug: `switch-${id}` } });
    await prisma.organizationMember.create({ data: { userId, organizationId: organizations[0], role: 'OWNER' } });
    const target = await prisma.organizationMember.create({ data: { userId, organizationId: organizations[1], role: 'MEMBER' } });
    await prisma.organizationMember.create({ data: { userId: otherUserId, organizationId: organizations[2], role: 'OWNER' } });
    const oldToken = jwt.sign({ userId, organizationId: organizations[0], role: 'OWNER' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const app = express(); app.use(express.json()); app.use('/auth', authRouter); app.use('/organizations', orgRouter);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    async function call(path, method = 'GET', body, token = oldToken) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      return { status: res.status, body: await res.json() };
    }
    let newToken;
    await t.test('list returns only this account memberships and no private fields', async () => {
      const result = await call('/auth/organizations');
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data.map(item => item.organization.id).sort(), organizations.slice(0, 2).sort());
      assert.ok(!JSON.stringify(result).includes('password'));
      assert.equal((await call('/auth/organizations', 'GET', undefined, null)).status, 401);
    });
    await t.test('switch preserves the account and uses the target database role', async () => {
      const result = await call('/auth/switch-organization', 'POST', { organizationId: organizations[1] });
      assert.equal(result.status, 200); newToken = result.body.data.token;
      const identity = jwt.verify(newToken, process.env.JWT_SECRET);
      assert.equal(identity.userId, userId); assert.equal(identity.organizationId, organizations[1]); assert.equal(identity.role, 'MEMBER');
      assert.equal(result.body.data.user.id, userId); assert.equal(result.body.data.user.password, undefined);
      assert.equal(result.body.data.organization.id, organizations[1]);
      assert.equal((await call('/auth/me', 'GET', undefined, newToken)).body.data.role, 'MEMBER');
      assert.equal((await call('/organizations/profile', 'GET', undefined, newToken)).body.data.id, organizations[1]);
      assert.equal((await call('/organizations/profile')).body.data.id, organizations[0]);
    });
    await t.test('foreign or missing targets, body overrides and malformed requests are rejected', async () => {
      const foreign = await call('/auth/switch-organization', 'POST', { organizationId: organizations[2] });
      const missing = await call('/auth/switch-organization', 'POST', { organizationId: randomUUID() });
      assert.equal(foreign.status, 404); assert.deepEqual(foreign, missing);
      for (const body of [{}, { organizationId: 'bad' }, { organizationId: organizations[2], userId: otherUserId }, { organizationId: organizations[1], role: 'OWNER' }])
        assert.equal((await call('/auth/switch-organization', 'POST', body)).status, 400);
      assert.equal((await call('/auth/switch-organization', 'POST', { organizationId: organizations[1] }, null)).status, 401);
    });
    await t.test('selected sessions isolate actual documents and conversations', async () => {
      const documents = [], conversations = [];
      for (const organizationId of organizations.slice(0, 2)) {
        documents.push(await prisma.document.create({ data: { organizationId, uploadedById: userId, name: 'fixture.txt', originalName: 'fixture.txt', mimeType: 'text/plain', size: 1, storagePath: 'unused-switch-fixture', status: 'COMPLETED' } }));
        conversations.push(await prisma.conversation.create({ data: { organizationId, userId, title: `Private ${organizationId}` } }));
      }
      // Resolve the identity from the actual new JWT, then use the same scoped
      // services called by document and history controllers.
      const scope = jwt.verify(newToken, process.env.JWT_SECRET);
      assert.equal(await getDocumentStatus(documents[0].id, scope.organizationId), null);
      assert.equal((await getDocumentStatus(documents[1].id, scope.organizationId)).id, documents[1].id);
      const owner = { userId: scope.userId, organizationId: scope.organizationId };
      const history = await listConversations(owner, 10);
      assert.deepEqual(history.conversations.map(item => item.id), [conversations[1].id]);
      await assert.rejects(readConversation(owner, conversations[0].id, 10));
      assert.equal((await readConversation(owner, conversations[1].id, 10)).conversation.id, conversations[1].id);
    });
    await t.test('fresh role verification and removed memberships cannot restore access', async () => {
      await prisma.organizationMember.update({ where: { id: target.id }, data: { role: 'ADMIN' } });
      assert.equal((await call('/auth/me', 'GET', undefined, newToken)).body.data.role, 'ADMIN');
      assert.equal((await call('/auth/switch-organization', 'POST', { organizationId: organizations[1] })).body.data.role, 'ADMIN');
      await prisma.organizationMember.delete({ where: { id: target.id } });
      assert.equal((await call('/auth/switch-organization', 'POST', { organizationId: organizations[1] })).status, 404);
      assert.equal((await call('/auth/me', 'GET', undefined, newToken)).status, 401);
      assert.equal((await call('/organizations/profile', 'GET', undefined, newToken)).status, 403);
      // A valid account token can still choose another current membership.
      assert.equal((await call('/auth/switch-organization', 'POST', { organizationId: organizations[0] }, newToken)).status, 200);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
    }
  }
});
