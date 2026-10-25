// Real database and HTTP/JWT; queue states are controlled without starting jobs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const router = require('../dist/src/document/document.routes').default;

test('document library is bounded, stable, current-member-only and organization scoped', { timeout: 60000 }, async t => {
  const organizationId = randomUUID(), foreignId = randomUUID(), emptyId = randomUUID();
  const userId = randomUUID(), outsiderId = randomUUID();
  const createdAt = new Date('2026-10-20T10:00:00.000Z');
  const originals = [];
  let server, unavailable = false, queueCalls = 0;
  const states = new Map();
  const oldSecret = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const id of [organizationId, foreignId, emptyId]) await prisma.organization.create({ data: { id, name: 'Library fixture', slug: `library-${id}` } });
    for (const id of [userId, outsiderId]) await prisma.user.create({ data: { id, name: 'Library user', email: `${id}@example.invalid`, password: 'private-password' } });
    for (const id of [organizationId, emptyId]) await prisma.organizationMember.create({ data: { userId, organizationId: id, role: 'MEMBER' } });
    for (let i = 0; i < 5; i++) {
      const row = await prisma.document.create({ data: {
        organizationId, uploadedById: userId, originalName: `Handbook ${i}.txt`, name: 'private-storage-name',
        storagePath: 'private/path', extractedText: 'private extracted text', errorMessage: 'private exception',
        status: 'COMPLETED', mimeType: 'text/plain', size: 42, createdAt,
      } });
      originals.push(row);
    }
    const foreign = await prisma.document.create({ data: { organizationId: foreignId, uploadedById: outsiderId, originalName: 'Foreign secret.txt', name: 'private', storagePath: 'private', mimeType: 'text/plain', size: 1, status: 'COMPLETED' } });
    const token = (org = organizationId, user = userId) => jwt.sign({ userId: user, organizationId: org, role: 'OWNER' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const app = express();
    app.locals.getDocumentQueue = async () => {
      queueCalls++; if (unavailable) throw new Error('private redis error');
      return { getState: async ({ documentId, organizationId: scopedId }) => {
        assert.equal(scopedId, organizationId); return states.get(documentId) ?? 'unknown';
      } };
    };
    app.use('/documents', router); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    async function call(query = '', auth = token()) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/documents${query}`, {
        headers: auth ? { Authorization: `Bearer ${auth}` } : {}, signal: AbortSignal.timeout(15000),
      });
      return { status: res.status, body: await res.json() };
    }
    await t.test('membership and safe metadata are enforced before queue lookup', async () => {
      const response = await call(); assert.equal(response.status, 200);
      assert.equal(response.body.data.organizationId, organizationId);
      assert.equal(response.body.data.documents.length, 5);
      for (const row of response.body.data.documents) {
        assert.equal(row.organizationId, organizationId); assert.equal(row.processingState, 'READY');
        assert.equal(row.mimeType, 'text/plain'); assert.equal(row.size, 42);
        assert.equal(row.errorMessage, null); assert.ok(row.createdAt);
      }
      const text = JSON.stringify(response.body);
      for (const secret of ['private', foreign.id, 'Foreign secret']) assert.ok(!text.includes(secret));
      assert.equal(queueCalls, 0);
      assert.equal((await call('', token(organizationId, outsiderId))).status, 403);
      assert.equal((await call('', null)).status, 401);
    });
    await t.test('tied timestamps paginate once each despite status updates and newer insertions', async () => {
      const first = await call('?limit=2'); const one = first.body.data;
      assert.equal(one.documents.length, 2); assert.equal(one.page.hasMore, true);
      await prisma.document.update({ where: { id: one.documents[0].id }, data: { errorMessage: 'changed while paging' } });
      const newer = await prisma.document.create({ data: { organizationId, uploadedById: userId, originalName: 'Newest.txt', name: 'new', storagePath: 'unused', size: 1, mimeType: 'text/plain', status: 'COMPLETED' } });
      const second = (await call(`?limit=2&cursor=${one.page.nextCursor}`)).body.data;
      const third = (await call(`?limit=2&cursor=${second.page.nextCursor}`)).body.data;
      const ids = [...one.documents, ...second.documents, ...third.documents].map(row => row.id);
      assert.deepEqual(ids, originals.map(row => row.id).sort().reverse());
      assert.equal(new Set(ids).size, 5); assert.equal(third.page.hasMore, false); assert.equal(third.page.nextCursor, null);
      assert.equal((await call('?limit=1')).body.data.documents[0].id, newer.id);
      await prisma.document.delete({ where: { id: newer.id } });
    });
    await t.test('cursor survives deletion of its boundary and rejects cross-tenant reuse or overrides', async () => {
      const first = (await call('?limit=1')).body.data;
      await prisma.document.delete({ where: { id: first.documents[0].id } });
      const next = await call(`?limit=1&cursor=${first.page.nextCursor}`);
      assert.equal(next.status, 200); assert.equal(next.body.data.documents.length, 1);
      assert.equal((await call(`?limit=1&cursor=${first.page.nextCursor}`, token(emptyId))).status, 400);
      for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=1.5', '?limit=1&limit=2', '?cursor=invalid', `?organizationId=${foreignId}`])
        assert.equal((await call(query)).status, 400);
    });
    await t.test('live queue states are shared with status reads and outages retain saved metadata', async () => {
      const ids = originals.slice().sort((a, b) => b.id.localeCompare(a.id)).slice(1).map(row => row.id);
      for (const [i, id] of ids.entries()) {
        await prisma.document.update({ where: { id }, data: { status: i === 0 ? 'FAILED' : 'PROCESSING' } });
        states.set(id, ['delayed', 'waiting', 'active', 'failed'][i]);
      }
      queueCalls = 0;
      const rows = (await call()).body.data.documents;
      assert.deepEqual(rows.map(row => row.processingState), ['RETRYING', 'QUEUED', 'PROCESSING', 'FAILED']);
      assert.equal(rows[0].canRetry, false); assert.equal(rows[0].errorMessage, null); assert.equal(queueCalls, 1);
      unavailable = true; queueCalls = 0;
      const down = (await call()).body.data.documents;
      assert.ok(down.every(row => row.processingState === 'UNAVAILABLE' && row.errorMessage === null));
      assert.equal(queueCalls, 1); assert.ok(!JSON.stringify(down).includes('private'));
      unavailable = false;
    });
    await t.test('empty teams return an empty terminal page and removal revokes listing', async () => {
      const result = await call('', token(emptyId)); assert.equal(result.status, 200);
      assert.deepEqual(result.body.data.documents, []); assert.equal(result.body.data.page.nextCursor, null);
      await prisma.organizationMember.delete({ where: { userId_organizationId: { userId, organizationId } } });
      const denied = await call(); assert.equal(denied.status, 403); assert.equal(denied.body.data, undefined);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      await prisma.organization.deleteMany({ where: { id: { in: [organizationId, foreignId, emptyId] } } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, outsiderId] } } });
    } finally {
      if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
      await prisma.$disconnect();
    }
  }
});
