// Real HTTP/JWT/PostgreSQL checks for one-time, email-bound organization invitations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const router = require('../dist/src/organization/organization.routes').default;
const authRouter = require('../dist/src/auth/auth.routes').default;

test('organization invitations expire and can be accepted once by the invited email', { timeout: 60000 }, async t => {
  const org = randomUUID();
  const ids = Object.fromEntries(['owner', 'admin', 'member', 'recipient', 'other', 'concurrent'].map(name => [name, randomUUID()]));
  const email = name => `${ids[name]}@example.invalid`;
  const originalSecret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const [name, id] of Object.entries(ids)) await prisma.user.create({ data: { id, name, email: email(name), password: 'fixture' } });
    await prisma.organization.create({ data: { id: org, name: 'Invitation fixture', slug: `invite-${org}` } });
    for (const [name, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['member', 'MEMBER']])
      await prisma.organizationMember.create({ data: { userId: ids[name], organizationId: org, role } });
    const token = (name, role = 'MEMBER', organizationId = org) => jwt.sign({ userId: ids[name], organizationId, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const app = express(); app.use(express.json()); app.use('/organizations', router); app.use('/auth', authRouter);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    async function call(method, path, body, auth = token('owner', 'OWNER')) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/organizations/invitations${path}`, {
        method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json() };
    }
    async function create(name, role = 'MEMBER', auth) {
      return call('POST', '', { email: email(name), role, expiresInDays: 7 }, auth);
    }

    await t.test('manager rules, validation, listing, and token secrecy', async () => {
      assert.equal((await create('recipient', 'MEMBER', token('member', 'OWNER'))).status, 403);
      assert.equal((await create('recipient', 'ADMIN', token('admin', 'ADMIN'))).status, 403);
      assert.equal((await create('recipient', 'MEMBER', token('admin', 'OWNER'))).status, 201);
      assert.equal((await create('recipient')).status, 409);
      assert.equal((await call('POST', '', { email: email('other'), role: 'MEMBER', expiresInDays: 0 })).status, 400);
      assert.equal((await call('POST', '', { email: email('other'), role: 'MEMBER', expiresInDays: 31 })).status, 400);
      const list = await call('GET', '');
      assert.equal(list.status, 200); assert.equal(list.body.data.role, 'OWNER'); assert.equal(list.body.data.invitations.length, 1);
      assert.equal(list.body.data.invitations[0].token, undefined); assert.equal(list.body.data.invitations[0].tokenHash, undefined);
      const stored = await prisma.organizationInvitation.findUniqueOrThrow({ where: { id: list.body.data.invitations[0].id } });
      assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
    });

    await t.test('wrong email cannot accept; correct email accepts once', async () => {
      const invitation = await prisma.organizationInvitation.findFirstOrThrow({ where: { organizationId: org, email: email('recipient') } });
      // Create a fresh invitation because the API reveals its secret only at creation.
      await prisma.organizationInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
      const created = await create('recipient'); const secret = created.body.data.token;
      assert.equal((await call('POST', '/accept', { token: secret }, token('other'))).status, 403);
      const accepted = await call('POST', '/accept', { token: secret }, token('recipient'));
      assert.equal(accepted.status, 200); assert.equal(accepted.body.data.organization.id, org);
      assert.equal((await call('POST', '/accept', { token: secret }, token('recipient'))).status, 409);
      assert.equal(await prisma.organizationMember.count({ where: { userId: ids.recipient, organizationId: org } }), 1);
    });

    await t.test('expired and revoked invitations cannot be accepted', async () => {
      const expired = await create('other');
      const hash = createHash('sha256').update(expired.body.data.token).digest('hex');
      await prisma.organizationInvitation.update({ where: { tokenHash: hash }, data: {
        createdAt: new Date(Date.now() - 172_800_000), expiresAt: new Date(Date.now() - 86_400_000),
      } });
      assert.equal((await call('POST', '/accept', { token: expired.body.data.token }, token('other'))).status, 410);
      await prisma.organizationInvitation.update({ where: { tokenHash: hash }, data: { revokedAt: new Date() } });
      const fresh = await create('other');
      assert.equal((await call('DELETE', `/${fresh.body.data.invitation.id}`)).status, 200);
      assert.equal((await call('POST', '/accept', { token: fresh.body.data.token }, token('other'))).status, 410);
    });

    await t.test('simultaneous acceptance creates exactly one membership', async () => {
      const created = await create('concurrent'); const secret = created.body.data.token;
      const responses = await Promise.all([
        call('POST', '/accept', { token: secret }, token('concurrent')),
        call('POST', '/accept', { token: secret }, token('concurrent')),
      ]);
      assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
      assert.equal(await prisma.organizationMember.count({ where: { userId: ids.concurrent, organizationId: org } }), 1);
    });
    await t.test('a new user registers directly into the invited organization', async () => {
      const newEmail = `${randomUUID()}@example.invalid`;
      const created = await call('POST', '', { email: newEmail, role: 'MEMBER', expiresInDays: 1 });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/register-invitation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ name: 'New Person', email: newEmail, password: 'password123', token: created.body.data.token }),
      });
      const body = await response.json();
      assert.equal(response.status, 201); assert.equal(body.data.organization.id, org); assert.equal(body.data.role, 'MEMBER');
      const user = await prisma.user.findUniqueOrThrow({ where: { email: newEmail } });
      assert.ok(await prisma.organizationMember.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: org } } }));
      assert.equal((await prisma.organizationInvitation.findUniqueOrThrow({ where: { id: created.body.data.invitation.id } })).acceptedById, user.id);
      await prisma.user.delete({ where: { id: user.id } });
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try { await prisma.organization.deleteMany({ where: { id: org } }); await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } }); }
    finally { if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret; await prisma.$disconnect(); }
  }
});
