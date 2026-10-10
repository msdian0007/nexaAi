// Real HTTP, JWT, transactions and PostgreSQL. The RAG service is controlled here
// to exercise save failures and races without spending provider quota.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../dist/src/config/database').default;
const rag = require('../dist/src/rag/rag.service');
const { GeminiProviderError } = require('../dist/src/rag/gemini.provider');
const router = require('../dist/src/rag/rag.routes').default;
const originalAnswer = rag.answerDocumentQuestion;
const originalSecret = process.env.JWT_SECRET;
const tenants = [], extraUsers = [];
let own, other, peer, url, server, generate, calls = 0;
const source = { sourceId: 'S1', documentId: 'fixture-document', chunkId: 'fixture-chunk', documentName: 'policy.txt', chunkIndex: 0, similarity: 0.8 };
const answer = () => ({ status: 'answered', answer: '18 days [S1].', citations: ['S1'], sources: [{ ...source }] });
const token = (userId, organizationId = userId) => jwt.sign({ userId, organizationId, role: 'MEMBER' }, process.env.JWT_SECRET, { expiresIn: '5m' });
async function tenant() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, name: 'Persistence test', email: `${id}@example.invalid`, password: 'unused',
    memberships: { create: { role: 'MEMBER', organization: { create: { id, name: 'Persistence test', slug: `persist-${id}` } } } },
  } });
  tenants.push(id);
  return id;
}
before(async () => {
  process.env.JWT_SECRET = randomUUID();
  own = await tenant(); other = await tenant(); peer = randomUUID();
  await prisma.user.create({ data: { id: peer, name: 'Peer', email: `${peer}@example.invalid`, password: 'unused',
    memberships: { create: { organizationId: own, role: 'MEMBER' } } } });
  extraUsers.push(peer);
  rag.answerDocumentQuestion = async (...args) => { calls++; return generate(...args); };
  const app = express(); app.use(express.json()); app.use('/api/v1/chat', router);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}/api/v1/chat/query`;
});
after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Membership cascades remove only these isolated fixtures' conversation trees.
    for (const id of tenants) await prisma.$transaction([
      prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
    ]);
    for (const id of extraUsers) await prisma.user.delete({ where: { id } });
  } finally {
    rag.answerDocumentQuestion = originalAnswer;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
    await prisma.$disconnect();
  }
});
async function query(body = {}, auth = token(own)) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ question: 'How much leave?', ...body }), signal: AbortSignal.timeout(20000) });
  return { status: response.status, body: await response.json() };
}
const messages = id => prisma.message.findMany({ where: { conversationId: id }, orderBy: { sequence: 'asc' }, include: { sources: true } });

test('creates and appends complete exchanges with server-owned citations and signed ownership', async () => {
  generate = answer;
  const first = await query({ question: ' How much leave? ', userId: peer, organizationId: other, sources: [{ sourceId: 'BAD' }] });
  assert.equal(first.status, 200);
  const data = first.body.data;
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: data.conversationId } });
  assert.equal(conversation.userId, own); assert.equal(conversation.organizationId, own);
  assert.equal(conversation.title, 'How much leave?');
  const saved = await messages(data.conversationId);
  assert.deepEqual(saved.map(m => [m.id, m.role, m.sequence]), [[data.userMessageId, 'USER', 0], [data.assistantMessageId, 'ASSISTANT', 1]]);
  assert.equal(saved[0].answerStatus, null); assert.equal(saved[0].content, 'How much leave?');
  assert.equal(saved[1].answerStatus, 'answered'); assert.equal(saved[1].content, data.answer);
  assert.deepEqual(saved[1].sources.map(({ id, messageId, organizationId, ...snapshot }) => snapshot), [source]);
  await prisma.conversation.update({ where: { id: data.conversationId }, data: { updatedAt: new Date('2020-01-01') } });
  const next = await query({ question: 'A second complete question?', conversationId: data.conversationId });
  assert.equal(next.status, 200); assert.equal(next.body.data.conversationId, data.conversationId);
  assert.deepEqual((await messages(data.conversationId)).map(m => m.sequence), [0, 1, 2, 3]);
  assert.ok((await prisma.conversation.findUniqueOrThrow({ where: { id: data.conversationId } })).updatedAt > new Date('2020-01-01'));
});

test('rejects inaccessible IDs, invalid input and removed membership before generation', async () => {
  const a = await prisma.conversation.create({ data: { userId: other, organizationId: other, title: 'Other tenant' } });
  const b = await prisma.conversation.create({ data: { userId: peer, organizationId: own, title: 'Same tenant, different owner' } });
  const previous = calls;
  for (const conversationId of [a.id, b.id, randomUUID()]) {
    const result = await query({ conversationId });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'CONVERSATION_NOT_FOUND');
  }
  for (const conversationId of [null, '', 42, {}, 'not-a-uuid']) assert.equal((await query({ conversationId })).status, 400);
  assert.equal((await query({}, jwt.sign({ organizationId: own }, process.env.JWT_SECRET))).status, 401);
  assert.equal((await query({}, token(other, own))).status, 403);
  assert.equal(calls, previous);
});

test('concurrent saves keep each question and answer adjacent with unique positions', async () => {
  generate = answer;
  const id = (await query()).body.data.conversationId;
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  generate = async (_org, question) => {
    if (++arrived === 2) release();
    await gate;
    return { ...answer(), answer: `Reply to ${question} [S1].` };
  };
  const results = await Promise.all([query({ conversationId: id, question: 'First?' }), query({ conversationId: id, question: 'Second?' })]);
  assert.ok(results.every(result => result.status === 200));
  const saved = await messages(id);
  assert.deepEqual(saved.map(m => m.sequence), [0, 1, 2, 3, 4, 5]);
  for (const index of [2, 4]) assert.equal(saved[index + 1].content, `Reply to ${saved[index].content} [S1].`);
});

test('provider failure and late database failure leave no partial new or existing exchange', async () => {
  generate = answer;
  const id = (await query()).body.data.conversationId;
  const before = await prisma.conversation.count({ where: { organizationId: own } });
  generate = () => { throw new GeminiProviderError('UNAVAILABLE', 'private provider details'); };
  assert.equal((await query()).status, 503);
  assert.equal((await query({ conversationId: id })).status, 503);
  // Deliberately violate a source CHECK constraint after both message inserts.
  // This tests actual rollback, not a stub that fails before the transaction starts.
  generate = () => ({ ...answer(), sources: [{ ...source, similarity: 2 }] });
  assert.equal((await query()).status, 500);
  assert.equal((await query({ conversationId: id })).status, 500);
  assert.equal(await prisma.conversation.count({ where: { organizationId: own } }), before);
  assert.equal((await messages(id)).length, 2);
});

test('membership revocation or conversation deletion during generation is rechecked before saving', async () => {
  const removed = await tenant();
  generate = async () => {
    await prisma.organizationMember.delete({ where: { userId_organizationId: { userId: removed, organizationId: removed } } });
    return answer();
  };
  assert.equal((await query({}, token(removed))).status, 403);
  assert.equal(await prisma.conversation.count({ where: { organizationId: removed } }), 0);
  generate = answer;
  const id = (await query()).body.data.conversationId;
  generate = async () => { await prisma.conversation.delete({ where: { id } }); return answer(); };
  assert.equal((await query({ conversationId: id })).status, 404);
  assert.equal(await prisma.conversation.count({ where: { id } }), 0);
});

test('insufficient and conflicting outcomes are saved as valid answers', async () => {
  for (const result of [
    { status: 'insufficient_information', answer: 'Not enough evidence.', citations: [], sources: [] },
    { status: 'conflicting_evidence', answer: '18 days [S1] conflicts with 25 days [S2].', citations: ['S1', 'S2'], sources: [source, { ...source, sourceId: 'S2', chunkId: 'other-chunk' }] },
  ]) {
    generate = () => result;
    const response = await query();
    assert.equal(response.status, 200);
    const saved = await messages(response.body.data.conversationId);
    assert.equal(saved[1].answerStatus, result.status);
    assert.equal(saved[1].sources.length, result.sources.length);
  }
});
