// Real authenticated HTTP and PostgreSQL reads. All data is isolated and fictional.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const router = require('../dist/src/rag/rag.routes').default;
const tenants = [], extraUsers = [];
const originalSecret = process.env.JWT_SECRET;
let own, other, peer, empty, conversations, peerChat, otherChat, server, url;
const sign = (userId, organizationId = userId) => jwt.sign({ userId, organizationId, role: 'MEMBER' }, process.env.JWT_SECRET);
const cursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function tenant() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, name: 'History read test', email: `${id}@example.invalid`, password: 'unused',
    memberships: { create: { role: 'MEMBER', organization: { create: { id, name: 'History read test', slug: `read-${id}` } } } },
  } });
  tenants.push(id); return id;
}
async function chat(userId, organizationId = userId, updatedAt = new Date('2026-01-01')) {
  return prisma.conversation.create({ data: { userId, organizationId, title: 'Leave policy', updatedAt } });
}
before(async () => {
  process.env.JWT_SECRET = randomUUID();
  own = await tenant(); other = await tenant(); empty = await tenant(); peer = randomUUID();
  await prisma.user.create({ data: { id: peer, name: 'Peer', email: `${peer}@example.invalid`, password: 'unused',
    memberships: { create: { organizationId: own } } } });
  extraUsers.push(peer);
  // Equal timestamps exercise the ID tie-breaker at pagination boundaries.
  conversations = await Promise.all([chat(own), chat(own), chat(own)]);
  conversations.sort((a, b) => b.id.localeCompare(a.id));
  peerChat = await chat(peer, own); otherChat = await chat(other);
  for (let sequence = 0; sequence < 4; sequence++) {
    const assistant = sequence % 2 === 1;
    await prisma.message.create({ data: { conversationId: conversations[0].id, organizationId: own, sequence,
      role: assistant ? 'ASSISTANT' : 'USER', content: assistant ? '18 days [S1].' : 'How much leave?', answerStatus: assistant ? 'answered' : null,
      // Snapshot references intentionally have no live document to join.
      sources: assistant ? { create: { sourceId: 'S1', documentId: 'deleted-doc', chunkId: 'old-chunk', documentName: 'original-policy.txt', chunkIndex: 2, similarity: 0.8 } } : undefined,
    } });
  }
  const app = express(); app.use(express.json()); app.use('/api/v1/chat', router);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}/api/v1/chat/conversations`;
});
after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const id of tenants) await prisma.$transaction([
      prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
    ]);
    for (const id of extraUsers) await prisma.user.delete({ where: { id } });
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
    await prisma.$disconnect();
  }
});
async function get(path = '', token = sign(own)) {
  const response = await fetch(url + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}

test('list pagination is deterministic at tied timestamps and exposes only owned summaries', async () => {
  const ids = []; let next = null;
  do {
    const result = await get(`?limit=1${next ? `&cursor=${next}` : ''}&organizationId=${other}&userId=${peer}`);
    assert.equal(result.status, 200); assert.equal(result.cache, 'no-store');
    const data = result.body.data;
    assert.equal(data.conversations.length, 1);
    assert.deepEqual(Object.keys(data.conversations[0]).sort(), ['createdAt', 'id', 'title', 'updatedAt']);
    ids.push(data.conversations[0].id);
    next = data.page.nextCursor;
    assert.equal(data.page.hasMore, next !== null);
  } while (next);
  assert.deepEqual(ids, conversations.map(c => c.id));
  assert.equal((await get()).body.data.page.limit, 20);
  const emptyResult = await get('', sign(empty));
  assert.deepEqual(emptyResult.body.data.conversations, []);
  assert.equal(emptyResult.body.data.page.nextCursor, null);
});

test('message pagination preserves order and historical source metadata without live documents', async () => {
  const id = conversations[0].id;
  const first = await get(`/${id}/messages?limit=1`);
  assert.equal(first.status, 200); assert.equal(first.body.data.conversation.id, id);
  assert.deepEqual(first.body.data.messages[0].citations, []);
  const next = first.body.data.page.nextCursor;
  const second = await get(`/${id}/messages?limit=2&cursor=${next}`);
  assert.deepEqual(second.body.data.messages.map(m => m.sequence), [1, 2]);
  const assistant = second.body.data.messages[0];
  assert.equal(assistant.answerStatus, 'answered'); assert.deepEqual(assistant.citations, ['S1']);
  assert.deepEqual(assistant.sources[0], { sourceId: 'S1', documentId: 'deleted-doc', chunkId: 'old-chunk', documentName: 'original-policy.txt', chunkIndex: 2, similarity: 0.8 });
  assert.equal(assistant.organizationId, undefined);
  const last = await get(`/${id}/messages?cursor=${second.body.data.page.nextCursor}`);
  assert.deepEqual(last.body.data.messages.map(m => m.sequence), [3]);
  assert.equal(last.body.data.page.hasMore, false);
  const blank = await get(`/${conversations[1].id}/messages`);
  assert.deepEqual(blank.body.data.messages, []);
});

test('other owners, other organizations and missing conversations all return the same 404', async () => {
  const results = await Promise.all([peerChat.id, otherChat.id, randomUUID()].map(id => get(`/${id}/messages`)));
  for (const result of results) {
    assert.equal(result.status, 404); assert.deepEqual(result.body, results[0].body);
  }
  assert.equal((await get(`/${conversations[0].id}/messages`, sign(peer, own))).status, 404);
});

test('rejects malformed limits/cursors and cursor reuse across conversations', async () => {
  for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=-1', 'limit=abc', 'limit=1&limit=2', 'limit=', 'cursor=', 'cursor=bad!', 'cursor=a&cursor=b', `cursor=${'a'.repeat(1025)}`]) {
    assert.equal((await get(`?${query}`)).status, 400, query);
    assert.equal((await get(`/${conversations[0].id}/messages?${query}`)).status, 400, query);
  }
  assert.equal((await get('/not-a-uuid/messages')).status, 400);
  for (const data of [null, [], {}, { kind: 'conversations', id: conversations[0].id, updatedAt: 'bad' }]) {
    assert.equal((await get(`?cursor=${cursor(data)}`)).status, 400);
  }
  const first = await get(`/${conversations[0].id}/messages?limit=1`);
  assert.equal((await get(`/${conversations[1].id}/messages?cursor=${first.body.data.page.nextCursor}`)).status, 400);
});

test('deleted cursor anchors do not break subsequent list pages', async () => {
  const fresh = await chat(own, own, new Date('2030-01-01'));
  const first = await get('?limit=1');
  assert.equal(first.body.data.conversations[0].id, fresh.id);
  await prisma.conversation.delete({ where: { id: fresh.id } });
  const following = await get(`?cursor=${first.body.data.page.nextCursor}`);
  assert.deepEqual(following.body.data.conversations.map(c => c.id), conversations.map(c => c.id));
});

test('requires signed identity and rejects revoked membership even with a valid JWT', async () => {
  for (const token of [null, 'invalid', jwt.sign({ userId: own }, process.env.JWT_SECRET)]) {
    assert.equal((await get('', token)).status, 401);
  }
  const revoked = await tenant(); const signed = sign(revoked);
  await prisma.organizationMember.delete({ where: { userId_organizationId: { userId: revoked, organizationId: revoked } } });
  assert.equal((await get('', signed)).status, 403);
  assert.equal((await get(`/${conversations[0].id}/messages`, signed)).status, 403);
});
