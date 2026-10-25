// Actual HTTP, signed tokens and PostgreSQL. No real organizations are renamed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const router = require('../dist/src/organization/organization.routes').default;

test('organization profile is scoped and only current owners can rename it', async t => {
  const org = randomUUID(), other = randomUUID();
  const ids = ['OWNER', 'ADMIN', 'MEMBER'].map(role => ({ id: randomUUID(), role }));
  const createdUsers = [], createdOrgs = [];
  const secret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const id of [org, other]) {
      await prisma.organization.create({ data: { id, name: 'Original Team', slug: `profile-${id}` } });
      createdOrgs.push(id);
    }
    for (const person of ids) {
      await prisma.user.create({ data: { id: person.id, name: person.role, email: `${person.id}@example.invalid`, password: 'unused',
        memberships: { create: { organizationId: org, role: person.role } } } });
      createdUsers.push(person.id);
    }
    const app = express();
    app.use(express.json()); app.use('/organizations', router);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    async function call(person = ids[0], method = 'GET', body, organizationId = org) {
      // Deliberately claim OWNER for everyone; database role must override this.
      const token = person ? jwt.sign({ userId: person.id, organizationId, role: 'OWNER' }, process.env.JWT_SECRET) : null;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/organizations/profile`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    }
    await t.test('all current roles can read; edit capability reflects database role', async () => {
      for (const person of ids) {
        const result = await call(person);
        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body.data).sort(), ['id', 'name', 'slug', 'createdAt', 'updatedAt', 'role', 'canEdit'].sort());
        assert.equal(result.body.data.id, org);
        assert.equal(result.body.data.role, person.role);
        assert.equal(result.body.data.canEdit, person.role === 'OWNER');
      }
    });
    await t.test('rename trims the name and preserves organization identity and memberships', async () => {
      const before = await prisma.organization.findUniqueOrThrow({ where: { id: org } });
      const members = await prisma.organizationMember.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } });
      const result = await call(ids[0], 'PATCH', { name: ' Nexa Support ' });
      assert.equal(result.status, 200);
      assert.equal(result.body.data.name, 'Nexa Support');
      assert.equal(result.body.data.slug, before.slug);
      assert.equal(result.body.data.id, before.id);
      assert.deepEqual(await prisma.organizationMember.findMany({ where: { organizationId: org }, orderBy: { id: 'asc' } }), members);
      assert.equal((await call()).body.data.name, 'Nexa Support');
      assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: other } })).name, 'Original Team');
    });
    await t.test('admins and members cannot edit despite OWNER token claims', async () => {
      for (const person of ids.slice(1)) assert.equal((await call(person, 'PATCH', { name: 'Forbidden' })).status, 403);
      assert.equal((await call()).body.data.name, 'Nexa Support');
    });
    await t.test('invalid names and extra fields cannot change identity or arbitrary fields', async () => {
      for (const body of [{}, { name: null }, { name: 42 }, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) },
        { name: 'line\nbreak' }, { name: 'Name', slug: 'changed' }, { name: 'Name', organizationId: other }, { name: 'Name', role: 'OWNER' }]) {
        assert.equal((await call(ids[0], 'PATCH', body)).status, 400);
      }
      assert.equal((await call()).body.data.name, 'Nexa Support');
    });
    await t.test('missing membership or authentication is rejected without exposing another profile', async () => {
      assert.equal((await call(null)).status, 401);
      assert.equal((await call(ids[0], 'GET', undefined, other)).status, 403);
      assert.equal((await call(ids[0], 'PATCH', { name: 'Forbidden' }, other)).status, 403);
      await prisma.organizationMember.deleteMany({ where: { organizationId: org, userId: ids[2].id } });
      assert.equal((await call(ids[2])).status, 403);
      await prisma.organizationMember.updateMany({ where: { organizationId: org, userId: ids[0].id }, data: { role: 'MEMBER' } });
      assert.equal((await call(ids[0], 'PATCH', { name: 'Stale owner' })).status, 403);
      assert.equal((await call()).body.data.canEdit, false);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrgs } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    } finally {
      if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
      await prisma.$disconnect();
    }
  }
});
