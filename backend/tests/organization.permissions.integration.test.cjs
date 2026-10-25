// Real HTTP/JWT and PostgreSQL. Temporary memberships exercise current-role
// authorization, organization isolation and concurrent writes without AI calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const router = require('../dist/src/organization/organization.routes').default;

test('organization member permissions use current database authority', { timeout: 60000 }, async t => {
  const org = randomUUID(), otherOrg = randomUUID();
  const users = Object.fromEntries(['owner', 'admin', 'member', 'outsider', 'candidate', 'second'].map(name => [name, randomUUID()]));
  const emails = Object.fromEntries(Object.entries(users).map(([name, id]) => [name, `${id}@example.invalid`]));
  const createdUsers = [], createdOrgs = [];
  const originalSecret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({ data: { id, name, email: emails[name], password: 'fixture-not-a-real-password' } });
      createdUsers.push(id);
    }
    for (const id of [org, otherOrg]) {
      await prisma.organization.create({ data: { id, name: 'Permission fixture', slug: `permissions-${id}` } });
      createdOrgs.push(id);
    }
    const memberships = {};
    for (const [name, role] of [['owner', 'OWNER'], ['admin', 'ADMIN'], ['member', 'MEMBER'], ['outsider', 'OWNER']]) {
      memberships[name] = await prisma.organizationMember.create({ data: {
        userId: users[name], organizationId: name === 'outsider' ? otherOrg : org, role,
      } });
    }
    const token = (name, role = 'OWNER', organizationId = org) => jwt.sign({ userId: users[name], organizationId, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const app = express();
    app.use(express.json());
    app.use('/organizations', router);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    async function call(method = 'GET', suffix = '', body, auth = token('owner')) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/organizations/members${suffix}`, {
        method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json() };
    }
    await t.test('current members can list only their own team without password fields', async () => {
      const response = await call('GET', '', undefined, token('member', 'MEMBER'));
      assert.equal(response.status, 200);
      assert.equal(response.body.data.length, 3);
      for (const item of response.body.data) {
        assert.equal(item.organizationId, org);
        assert.equal(item.user.password, undefined);
        assert.ok(!JSON.stringify(item).includes('fixture-not-a-real-password'));
      }
    });
    await t.test('regular members cannot manage others even with an old OWNER claim', async () => {
      const stale = token('member');
      assert.equal((await call('POST', '', { email: emails.candidate }, stale)).status, 403);
      assert.equal((await call('PATCH', `/${memberships.member.id}/role`, { role: 'ADMIN' }, stale)).status, 403);
      assert.equal((await call('DELETE', `/${memberships.admin.id}`, undefined, stale)).status, 403);
    });
    await t.test('administrators add/remove regular members but cannot assign elevated roles', async () => {
      const admin = token('admin', 'ADMIN');
      for (const role of ['ADMIN', 'OWNER']) {
        assert.equal((await call('POST', '', { email: emails.candidate, role }, admin)).status, 403);
        assert.equal((await call('PATCH', `/${memberships.member.id}/role`, { role }, admin)).status, 403);
      }
      assert.equal((await call('DELETE', `/${memberships.admin.id}`, undefined, admin)).status, 403);
      const added = await call('POST', '', { email: ` ${emails.candidate.toUpperCase()} ` }, admin);
      assert.equal(added.status, 201);
      assert.equal(added.body.data.role, 'MEMBER');
      assert.equal(added.body.data.user.password, undefined);
      assert.equal((await call('DELETE', `/${added.body.data.id}`, undefined, admin)).status, 200);
    });
    await t.test('owner can promote/demote admins and add another owner; existing owners stay protected', async () => {
      // A promoted user's older token may still say MEMBER; the database role wins.
      const owner = token('owner', 'MEMBER');
      assert.equal((await call('PATCH', `/${memberships.member.id}/role`, { role: 'ADMIN' }, owner)).status, 200);
      assert.equal((await call('PATCH', `/${memberships.member.id}/role`, { role: 'MEMBER' }, owner)).status, 200);
      const added = await call('POST', '', { email: emails.second, role: 'OWNER' }, owner);
      assert.equal(added.status, 201);
      for (const id of [memberships.owner.id, added.body.data.id]) {
        assert.equal((await call('DELETE', `/${id}`, undefined, owner)).status, 409);
        assert.equal((await call('PATCH', `/${id}/role`, { role: 'MEMBER' }, owner)).status, 409);
      }
    });
    await t.test('demotion and removal immediately revoke member-management authority', async () => {
      const oldAdmin = token('admin', 'ADMIN');
      await prisma.organizationMember.update({ where: { id: memberships.admin.id }, data: { role: 'MEMBER' } });
      assert.equal((await call('POST', '', { email: emails.candidate }, oldAdmin)).status, 403);
      await prisma.organizationMember.delete({ where: { id: memberships.admin.id } });
      assert.equal((await call('GET', '', undefined, oldAdmin)).status, 403);
      assert.equal((await call('POST', '', { email: emails.candidate }, oldAdmin)).status, 403);
      memberships.admin = await prisma.organizationMember.create({ data: { userId: users.admin, organizationId: org, role: 'ADMIN' } });
    });
    await t.test('another organization cannot be targeted through IDs or body overrides', async () => {
      const missing = await call('DELETE', `/${randomUUID()}`);
      const foreign = await call('DELETE', `/${memberships.outsider.id}`, { organizationId: otherOrg });
      assert.equal(foreign.status, 404);
      assert.deepEqual(foreign, missing);
      assert.equal((await call('PATCH', `/${memberships.outsider.id}/role`, { role: 'MEMBER', organizationId: otherOrg })).status, 404);
      assert.equal((await call('GET', '', undefined, token('outsider', 'OWNER', org))).status, 403);
      assert.equal((await prisma.organizationMember.findUniqueOrThrow({ where: { id: memberships.outsider.id } })).role, 'OWNER');
    });
    await t.test('invalid inputs and missing authentication return controlled errors', async () => {
      assert.equal((await call('GET', '', undefined, null)).status, 401);
      for (const body of [{}, { email: 7 }, { email: ' ' }, { email: 'invalid' }, { email: emails.candidate, role: 'ROOT' }, { email: emails.candidate, role: null }]) {
        assert.equal((await call('POST', '', body)).status, 400);
      }
      for (const role of [null, 'ROOT', {}, 7]) assert.equal((await call('PATCH', `/${memberships.member.id}/role`, { role })).status, 400);
      assert.equal((await call('DELETE', '/invalid')).status, 400);
      assert.equal((await call('POST', '', { email: `${randomUUID()}@example.invalid` })).status, 404);
    });
    await t.test('simultaneous duplicate additions create one membership', async () => {
      const responses = await Promise.all([call('POST', '', { email: emails.candidate }), call('POST', '', { email: emails.candidate })]);
      assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
      assert.equal(await prisma.organizationMember.count({ where: { userId: users.candidate, organizationId: org } }), 1);
    });
    await t.test('a concurrent owner promotion and removal cannot delete a promoted owner', async () => {
      const target = await prisma.organizationMember.findUniqueOrThrow({ where: { userId_organizationId: { userId: users.candidate, organizationId: org } } });
      const [promoted, removed] = await Promise.all([
        call('PATCH', `/${target.id}/role`, { role: 'OWNER' }),
        call('DELETE', `/${target.id}`, undefined, token('admin', 'ADMIN')),
      ]);
      const after = await prisma.organizationMember.findUnique({ where: { id: target.id } });
      if (promoted.status === 200) {
        assert.equal(removed.status, 409);
        assert.equal(after.role, 'OWNER');
      } else {
        assert.equal(promoted.status, 404);
        assert.equal(removed.status, 200);
        assert.equal(after, null);
      }
      assert.ok(await prisma.organizationMember.count({ where: { organizationId: org, role: 'OWNER' } }) >= 1);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgs } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
    }
  }
});
