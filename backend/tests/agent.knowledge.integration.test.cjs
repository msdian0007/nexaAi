// Real PostgreSQL/pgvector retrieval, context construction and citation validation.
// Only embeddings and provider transport are controlled; no live model quota is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const prisma = require('../dist/src/config/database').default;
const embeddingId = require.resolve('../dist/src/document/document.embedding');
let embeddingCalls = 0, providerCalls = 0, generate;
const vector = [1, ...Array(383).fill(0)];
require.cache[embeddingId] = { id: embeddingId, filename: embeddingId, loaded: true, exports: {
  generateEmbedding: async () => { embeddingCalls++; return vector; },
} };
const provider = require('../dist/src/rag/gemini.provider');
const originalGenerate = provider.generateGeminiText;
provider.generateGeminiText = async messages => { providerCalls++; return generate(messages); };
const { executeKnowledgeTool } = require('../dist/src/agents/knowledge.tool');
const { AgentContractError } = require('../dist/src/agents/agent.contracts');
const { AgentIdentityError, AgentMembershipError } = require('../dist/src/agents/agent.access');
const { RagResponseValidationError } = require('../dist/src/rag/rag.response');
const call = question => ({ tool: 'knowledge_answer', input: { question } });

test('knowledge executor enforces current access and uses scoped, validated RAG', { timeout: 60000 }, async t => {
  const own = randomUUID(), foreign = randomUUID(), empty = randomUUID();
  const user = randomUUID(), foreignUser = randomUUID();
  const organizations = [], users = [];
  const context = { userId: user, organizationId: own };
  const prompts = [];
  function response(messages) {
    const input = JSON.parse(messages[1].content);
    prompts.push(input);
    assert.equal(input.evidence.length > 0, true);
    for (const passage of input.evidence) {
      assert.equal(passage.content.includes('FOREIGN_SECRET'), false);
      assert.equal(passage.content.includes('EXCLUDED_SECRET'), false);
    }
    return JSON.stringify({ status: 'answered', answer: 'Employees receive 18 days [S1].', citations: ['S1'] });
  }
  async function seed(org, options = {}) {
    const row = await prisma.document.create({ data: {
      organizationId: org, uploadedById: org === foreign ? foreignUser : user,
      name: 'private-storage-name', originalName: org === foreign ? 'foreign.txt' : 'handbook.txt',
      mimeType: 'text/plain', size: 42, storagePath: 'private/storage/path',
      status: options.status ?? 'COMPLETED',
      deletionRequestedAt: options.deleting ? new Date() : null,
      chunks: { create: { chunkIndex: 0, content: options.content ?? 'Employees receive 18 annual leave days.',
        embeddingStatus: options.embeddingStatus ?? 'COMPLETED' } },
    }, include: { chunks: true } });
    if (!options.noVector) {
      const value = `[${(options.vector ?? vector).join(',')}]`;
      await prisma.$executeRaw`UPDATE "DocumentChunk" SET "embedding" = ${value}::vector(384) WHERE "id" = ${row.chunks[0].id}`;
    }
    return row;
  }
  async function restoreMembership() {
    await prisma.organizationMember.upsert({ where: { userId_organizationId: context },
      create: { ...context, role: 'MEMBER' }, update: { role: 'MEMBER' } });
  }
  try {
    for (const id of [own, foreign, empty]) {
      await prisma.organization.create({ data: { id, name: 'Agent knowledge fixture', slug: `agent-knowledge-${id}` } });
      organizations.push(id);
    }
    for (const id of [user, foreignUser]) {
      await prisma.user.create({ data: { id, name: 'Knowledge fixture', email: `${id}@example.invalid`, password: 'unused' } });
      users.push(id);
    }
    for (const organizationId of [own, empty]) await prisma.organizationMember.create({ data: { userId: user, organizationId, role: 'MEMBER' } });
    await prisma.organizationMember.create({ data: { userId: foreignUser, organizationId: foreign, role: 'OWNER' } });
    const handbook = await seed(own);
    await seed(foreign, { content: 'FOREIGN_SECRET employees receive 99 days.' });
    for (const options of [
      { status: 'FAILED' }, { status: 'UPLOADED' }, { status: 'PROCESSING' }, { deleting: true },
      { embeddingStatus: 'PENDING' }, { noVector: true }, { vector: Array(384).fill(0) },
      { vector: [0, 1, ...Array(382).fill(0)] },
    ]) await seed(own, { ...options, content: 'EXCLUDED_SECRET must not be retrieved.' });
    generate = response;

    await t.test('all current roles receive only their organization evidence and original source metadata', async () => {
      for (const role of ['MEMBER', 'ADMIN', 'OWNER']) {
        await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role } });
        const result = await executeKnowledgeTool(context, call('  How much leave?  '));
        assert.equal(result.tool, 'knowledge_answer');
        assert.equal(result.data.answer, 'Employees receive 18 days [S1].');
        assert.deepEqual(result.data.citations, ['S1']);
        assert.equal(result.data.sources.length, 1);
        const source = result.data.sources[0];
        assert.equal(source.documentId, handbook.id);
        assert.equal(source.chunkId, handbook.chunks[0].id);
        assert.equal(source.documentName, 'handbook.txt');
        assert.equal(source.chunkIndex, 0);
        assert.equal(prompts.at(-1).question, 'How much leave?');
        for (const hidden of ['private/storage/path', 'private-storage-name', 'FOREIGN_SECRET', 'EXCLUDED_SECRET']) {
          assert.equal(JSON.stringify(result).includes(hidden), false);
        }
      }
      await restoreMembership();
    });

    await t.test('invalid identity, inaccessible organization and extra model arguments fail before embedding or generation', async () => {
      const before = [embeddingCalls, providerCalls];
      for (const identity of [null, {}, [], { userId: user }, { ...context, organizationId: 'bad' }]) {
        await assert.rejects(executeKnowledgeTool(identity, call('Question?')), AgentIdentityError);
      }
      await assert.rejects(executeKnowledgeTool({ userId: foreignUser, organizationId: own, role: 'OWNER' }, call('Question?')), AgentMembershipError);
      for (const proposal of [
        { tool: 'document_counts', input: {} }, { tool: 'retry_document', input: { documentId: handbook.id } },
        { tool: 'knowledge_answer', input: { question: 'Question?', organizationId: foreign } },
        { tool: 'knowledge_answer', input: { question: 'Question?', topK: 100 } }, call(' '),
      ]) await assert.rejects(executeKnowledgeTool(context, proposal), AgentContractError);
      assert.deepEqual([embeddingCalls, providerCalls], before);
    });

    await t.test('empty organization returns insufficient information without provider calls or foreign citations', async () => {
      const before = providerCalls;
      const result = await executeKnowledgeTool({ userId: user, organizationId: empty }, call('How much leave?'));
      assert.equal(result.data.status, 'insufficient_information');
      assert.deepEqual(result.data.sources, []);
      assert.deepEqual(result.data.citations, []);
      assert.equal(providerCalls, before);
    });

    await t.test('server-owned retrieval limits context to five passages', async () => {
      const extras = [];
      try {
        for (let i = 0; i < 7; i++) extras.push((await seed(own)).id);
        await executeKnowledgeTool(context, call('How much leave?'));
        assert.equal(prompts.at(-1).evidence.length, 5);
      } finally {
        await prisma.document.deleteMany({ where: { id: { in: extras }, organizationId: own } });
      }
    });

    await t.test('provider errors and invalid citations propagate without fallback or automatic retry', async () => {
      const failure = new provider.GeminiProviderError('UNAVAILABLE', 'Controlled provider failure');
      generate = async () => { throw failure; };
      let before = providerCalls;
      await assert.rejects(executeKnowledgeTool(context, call('Question?')), error => error === failure);
      assert.equal(providerCalls, before + 1);
      generate = async () => JSON.stringify({ status: 'answered', answer: 'Invented source [S99].', citations: ['S99'] });
      before = providerCalls;
      await assert.rejects(executeKnowledgeTool(context, call('Question?')), RagResponseValidationError);
      assert.equal(providerCalls, before + 1);
      generate = response;
    });

    await t.test('removed membership prevents retrieval even if a caller has an old OWNER assertion', async () => {
      await prisma.organizationMember.delete({ where: { userId_organizationId: context } });
      try {
        const before = [embeddingCalls, providerCalls];
        await assert.rejects(executeKnowledgeTool({ ...context, role: 'OWNER' }, call('Question?')), AgentMembershipError);
        assert.deepEqual([embeddingCalls, providerCalls], before);
      } finally { await restoreMembership(); }
    });

    await t.test('membership can be removed during generation and the result is withheld afterward', async () => {
      generate = async messages => {
        // This write succeeds while generation is pending: no long-held membership lock.
        await prisma.organizationMember.delete({ where: { userId_organizationId: context } });
        return response(messages);
      };
      try {
        await assert.rejects(executeKnowledgeTool(context, call('Question?')), AgentMembershipError);
      } finally { generate = response; await restoreMembership(); }
    });

    await t.test('mutating the caller context while generation runs cannot change the copied scope', async () => {
      const mutable = { ...context };
      generate = async messages => {
        mutable.organizationId = foreign;
        mutable.userId = foreignUser;
        return response(messages);
      };
      try {
        const result = await executeKnowledgeTool(mutable, call('Question?'));
        assert.equal(result.data.sources[0].documentId, handbook.id);
      } finally { generate = response; }
    });

    await t.test('knowledge execution leaves documents and private chat history unchanged', async () => {
      const original = await prisma.document.findUniqueOrThrow({ where: { id: handbook.id }, include: { chunks: true } });
      const before = await prisma.conversation.count({ where: { organizationId: own } });
      await executeKnowledgeTool(context, call('Question?'));
      assert.deepEqual(await prisma.document.findUniqueOrThrow({ where: { id: handbook.id }, include: { chunks: true } }), original);
      assert.equal(await prisma.conversation.count({ where: { organizationId: own } }), before);
      assert.equal(await prisma.message.count({ where: { organizationId: own } }), 0);
      assert.equal(await prisma.messageSource.count({ where: { organizationId: own } }), 0);
    });
  } finally {
    provider.generateGeminiText = originalGenerate;
    try {
      // Exact fixture IDs only; cascades remove their document/chunk records.
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally { await prisma.$disconnect(); }
  }
});
