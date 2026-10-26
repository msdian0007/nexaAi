// Production HTTP stack with real JWTs/PostgreSQL/pgvector. Only local inference,
// Gemini transport and allowance acceptance are controlled; no provider quota.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
let inferenceCalls = 0;
const vector = [1, ...Array(383).fill(0)];
const embeddingId = require.resolve('../dist/src/document/document.embedding');
require.cache[embeddingId] = { id: embeddingId, filename: embeddingId, loaded: true,
  exports: { generateEmbedding: async () => { inferenceCalls++; return [...vector]; } } };
const prisma = require('../dist/src/config/database').default;
const provider = require('../dist/src/rag/gemini.provider');
const { createApiApp } = require('../dist/src/api');
const { issueAuthToken } = require('../dist/src/auth/auth.tokens');

test('a warm embedding cache keeps permissions, database freshness and generation intact', { timeout: 60000 }, async t => {
  const org = randomUUID(), foreign = randomUUID(), user = randomUUID(), outsider = randomUUID();
  const priorSecret = process.env.JWT_SECRET, priorGenerator = provider.generateGeminiText;
  process.env.JWT_SECRET = randomUUID();
  let server, admissions = 0, denyAdmission = false, providerCalls = 0;
  const query = 'How much leave is allowed?';
  async function document(organizationId, uploadedById, content) {
    const result = await prisma.document.create({ data: { organizationId, uploadedById, name: 'fixture', originalName: 'policy.txt',
      mimeType: 'text/plain', size: content.length, storagePath: 'unused-fixture-path', status: 'COMPLETED',
      chunks: { create: { chunkIndex: 0, content, embeddingStatus: 'COMPLETED' } } }, include: { chunks: true } });
    const encoded = `[${vector.join(',')}]`;
    await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${encoded}::vector(384) WHERE id = ${result.chunks[0].id}`;
    return result;
  }
  try {
    for (const id of [org, foreign]) await prisma.organization.create({ data: { id, name: 'Cache fixture', slug: `cache-${id}` } });
    for (const [id, organizationId] of [[user, org], [outsider, foreign]]) {
      await prisma.user.create({ data: { id, name: 'Cache fixture', email: `${id}@example.invalid`, password: 'unused' } });
      await prisma.organizationMember.create({ data: { userId: id, organizationId, role: 'OWNER' } });
    }
    const own = await document(org, user, 'VERSION_ONE leave policy');
    await document(foreign, outsider, 'FOREIGN_PRIVATE_POLICY');
    const tokens = { [user]: issueAuthToken({ userId: user, organizationId: org, role: 'OWNER' }).token,
      [outsider]: issueAuthToken({ userId: outsider, organizationId: foreign, role: 'OWNER' }).token };
    const app = createApiApp({ admissionStore: { consume: async () => { admissions++; return denyAdmission ? 60 : 0; } } });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function call(route = '/documents/search', body = { query, minSimilarity: 0 }, identity = user, token = tokens[identity]) {
      const result = await fetch(base + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      assert.equal(result.headers.get('cache-control'), 'no-store');
      return { status: result.status, body: await result.json() };
    }
    const results = async () => { const result = await call(); assert.equal(result.status, 200); return result.body.data.results; };
    await t.test('repeated requests share inference while each passes production admission', async () => {
      assert.equal((await results())[0].content, 'VERSION_ONE leave policy');
      assert.equal((await results())[0].content, 'VERSION_ONE leave policy');
      assert.equal(inferenceCalls, 1); assert.equal(admissions, 2);
    });
    await t.test('renamed documents and changed passages are visible with the existing cached question vector', async () => {
      await prisma.document.update({ where: { id: own.id }, data: { originalName: 'renamed.txt' } });
      await prisma.documentChunk.update({ where: { id: own.chunks[0].id }, data: { content: 'VERSION_TWO leave policy' } });
      const found = await results(); assert.equal(found[0].documentName, 'renamed.txt');
      assert.equal(found[0].content, 'VERSION_TWO leave policy'); assert.equal(inferenceCalls, 1);
    });
    await t.test('pending deletion and processing-state changes take effect without waiting for cache expiry', async () => {
      await prisma.document.update({ where: { id: own.id }, data: { deletionRequestedAt: new Date() } });
      assert.deepEqual(await results(), []);
      await prisma.document.update({ where: { id: own.id }, data: { deletionRequestedAt: null, status: 'PROCESSING' } });
      assert.deepEqual(await results(), []);
      await prisma.document.update({ where: { id: own.id }, data: { status: 'COMPLETED' } });
      assert.equal((await results()).length, 1); assert.equal(inferenceCalls, 1);
    });
    await t.test('newly indexed and permanently deleted documents change the next search', async () => {
      const added = await document(org, user, 'NEWLY_INDEXED leave policy');
      assert.equal((await results()).length, 2);
      await prisma.document.delete({ where: { id: added.id } });
      assert.equal((await results()).length, 1);
      await prisma.document.delete({ where: { id: own.id } });
      assert.deepEqual(await results(), []); assert.equal(inferenceCalls, 1);
    });
    await t.test('identical questions in another organization miss independently and return only its passages', async () => {
      const other = await call('/documents/search', { query, minSimilarity: 0 }, outsider);
      assert.equal(other.status, 200); assert.equal(inferenceCalls, 2);
      assert.equal(other.body.data.results.length, 1); assert.equal(other.body.data.results[0].content, 'FOREIGN_PRIVATE_POLICY');
      assert.equal((await call('/documents/search', { query, organizationId: foreign })).status, 400);
      assert.equal(inferenceCalls, 2);
    });
    await t.test('a warm cache cannot bypass revoked membership or invalid authentication', async () => {
      await prisma.organizationMember.delete({ where: { userId_organizationId: { userId: user, organizationId: org } } });
      assert.equal((await call()).status, 403);
      assert.equal((await call('/documents/search', { query }, user, 'invalid')).status, 401);
      assert.equal(inferenceCalls, 2);
      await prisma.organizationMember.create({ data: { userId: user, organizationId: org, role: 'OWNER' } });
    });
    await t.test('rate limits still reject a warm cache hit before work', async () => {
      denyAdmission = true;
      try { const result = await call(); assert.equal(result.status, 429); assert.equal(result.body.code, 'RATE_LIMITED'); }
      finally { denyAdmission = false; }
      assert.equal(inferenceCalls, 2);
    });
    await t.test('Chat reuses the query vector but calls generation and saves each exchange separately', async () => {
      await document(org, user, 'Employees receive 18 days of leave.');
      provider.generateGeminiText = async () => { providerCalls++; return JSON.stringify({ status: 'answered', answer: 'Employees receive 18 days [S1].', citations: ['S1'] }); };
      const first = await call('/chat/query', { question: query }); assert.equal(first.status, 200);
      const second = await call('/chat/query', { question: query, conversationId: first.body.data.conversationId }); assert.equal(second.status, 200);
      assert.equal(providerCalls, 2); assert.equal(inferenceCalls, 2);
      assert.notEqual(first.body.data.assistantMessageId, second.body.data.assistantMessageId);
      assert.equal(await prisma.message.count({ where: { organizationId: org } }), 4);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    provider.generateGeminiText = priorGenerator;
    await prisma.organization.deleteMany({ where: { id: { in: [org, foreign] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user, outsider] } } });
    if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
    await prisma.$disconnect();
  }
});
