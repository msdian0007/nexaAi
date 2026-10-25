// Real PostgreSQL + authenticated HTTP. Generation is a gated fixture so a late
// answer can be tested without a Gemini call or artificial database writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
let generationGate;
const ragPath = require.resolve('../dist/src/rag/rag.service');
require.cache[ragPath] = { id: ragPath, filename: ragPath, loaded: true, exports: {
  answerDocumentQuestion: async (_org, question) => {
    if (generationGate) { generationGate.started(); await generationGate.wait; }
    return { question, status: 'insufficient_information', answer: 'No supporting evidence.', sources: [], citations: [] };
  },
} };
const router = require('../dist/src/rag/rag.routes').default;
const { answerAndSaveQuestion, ConversationNotFoundError } = require('../dist/src/conversation/conversation.service');

test('private conversation deletion cascades history and never grants owner/admin access to peer chats', { timeout: 60000 }, async t => {
  const organizationId = randomUUID(), foreignOrg = randomUUID();
  const userId = randomUUID(), peerId = randomUUID();
  const oldSecret = process.env.JWT_SECRET;
  let server;
  try {
    process.env.JWT_SECRET = randomUUID();
    for (const id of [organizationId, foreignOrg]) await prisma.organization.create({ data: { id, name: 'Chat deletion fixture', slug: `chat-delete-${id}` } });
    for (const id of [userId, peerId]) await prisma.user.create({ data: { id, name: 'Fixture user', email: `${id}@example.invalid`, password: 'unused' } });
    await prisma.organizationMember.create({ data: { userId, organizationId, role: 'MEMBER' } });
    await prisma.organizationMember.create({ data: { userId: peerId, organizationId, role: 'OWNER' } });
    await prisma.organizationMember.create({ data: { userId, organizationId: foreignOrg, role: 'MEMBER' } });
    const owner = { userId, organizationId };
    const token = (user = userId, org = organizationId, role = 'OWNER') => jwt.sign({ userId: user, organizationId: org, role }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const app = express(); app.use(express.json()); app.use('/chat', router);
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    async function call(id, method = 'DELETE', auth = token(), body, query = '') {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/chat/conversations/${id}${query}`, {
        method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      return { status: result.status, body: await result.json(), cache: result.headers.get('cache-control') };
    }
    async function chat(user = userId, org = organizationId) {
      return prisma.conversation.create({ data: { userId: user, organizationId: org, title: 'Fictional leave policy' } });
    }
    await t.test('a current regular member deletes only their history; documents and peer history stay unchanged', async () => {
      const own = await chat(), peer = await chat(peerId);
      const document = await prisma.document.create({ data: { organizationId, uploadedById: userId, name: 'fixture.txt', originalName: 'policy.txt', mimeType: 'text/plain', size: 42, storagePath: 'not-touched', status: 'COMPLETED',
        chunks: { create: { chunkIndex: 0, content: 'Eighteen days.' } },
      }, include: { chunks: true } });
      const message = await prisma.message.create({ data: { conversationId: own.id, organizationId, role: 'ASSISTANT', sequence: 0, answerStatus: 'answered', content: 'Eighteen days [S1].' } });
      const source = await prisma.messageSource.create({ data: { messageId: message.id, organizationId, sourceId: 'S1', documentId: document.id, chunkId: document.chunks[0].id, documentName: 'policy.txt', chunkIndex: 0, similarity: 1 } });
      const result = await call(own.id); assert.equal(result.status, 200); assert.equal(result.cache, 'no-store');
      assert.deepEqual(result.body, { success: true, data: { conversationId: own.id, deleted: true } });
      assert.equal(await prisma.conversation.findUnique({ where: { id: own.id } }), null);
      assert.equal(await prisma.message.findUnique({ where: { id: message.id } }), null);
      assert.equal(await prisma.messageSource.findUnique({ where: { id: source.id } }), null);
      assert.deepEqual(await prisma.document.findUnique({ where: { id: document.id }, include: { chunks: true } }), document);
      assert.deepEqual(await prisma.conversation.findUnique({ where: { id: peer.id } }), peer);
      assert.equal((await call(`${own.id}/messages`, 'GET')).status, 404);
      assert.equal((await call(own.id)).status, 404);
    });
    await t.test('peer, foreign and missing IDs have identical 404 responses even for elevated roles', async () => {
      const peer = await chat(peerId), foreign = await chat(userId, foreignOrg), own = await chat();
      const missing = await call(randomUUID());
      for (const id of [peer.id, foreign.id]) assert.deepEqual(await call(id), missing);
      // An actual OWNER membership still gives no access to another person's private chat.
      assert.deepEqual(await call(own.id, 'DELETE', token(peerId)), missing);
      assert.ok(await prisma.conversation.findUnique({ where: { id: own.id } }));
    });
    await t.test('malformed identity, path, query and body cannot override ownership', async () => {
      const own = await chat();
      assert.equal((await call(own.id, 'DELETE', null)).status, 401);
      assert.equal((await call(own.id, 'DELETE', jwt.sign({ userId }, process.env.JWT_SECRET))).status, 401);
      assert.equal((await call('not-a-uuid')).status, 400);
      assert.equal((await call(own.id, 'DELETE', token(), { userId: peerId })).status, 400);
      assert.equal((await call(own.id, 'DELETE', token(), [])).status, 400);
      assert.equal((await call(own.id, 'DELETE', token(), undefined, `?organizationId=${foreignOrg}`)).status, 400);
      assert.ok(await prisma.conversation.findUnique({ where: { id: own.id } }));
    });
    await t.test('an answer finishing after deletion cannot recreate the deleted conversation', async () => {
      const own = await chat(); let start, release;
      const started = new Promise(resolve => { start = resolve; });
      generationGate = { started: start, wait: new Promise(resolve => { release = resolve; }) };
      // Attach rejection handling immediately; the delayed save must fail deliberately.
      const answer = answerAndSaveQuestion(owner, 'A continued question?', 5, 0.35, own.id).then(() => null, error => error);
      try {
        await started; assert.equal((await call(own.id)).status, 200);
      } finally { release(); generationGate = undefined; }
      assert.ok(await answer instanceof ConversationNotFoundError);
      assert.equal(await prisma.conversation.findUnique({ where: { id: own.id } }), null);
      assert.equal(await prisma.message.count({ where: { conversationId: own.id } }), 0);
    });
    await t.test('concurrent deletions remove a conversation once without touching its neighbors', async () => {
      const own = await chat(), neighbor = await chat();
      const results = await Promise.all([call(own.id), call(own.id)]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 404]);
      assert.deepEqual(await prisma.conversation.findUnique({ where: { id: neighbor.id } }), neighbor);
    });
    await t.test('removed memberships cannot delete using an old signed token', async () => {
      const signed = token();
      await prisma.organizationMember.delete({ where: { userId_organizationId: owner } });
      assert.equal((await call(randomUUID(), 'DELETE', signed)).status, 403);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      await prisma.organization.deleteMany({ where: { id: { in: [organizationId, foreignOrg] } } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, peerId] } } });
    } finally { if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; await prisma.$disconnect(); }
  }
});
