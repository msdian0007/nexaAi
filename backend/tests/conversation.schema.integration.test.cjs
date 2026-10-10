// Real database checks for the new constraints. No provider requests or real users.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const prisma = require('../dist/src/config/database').default;

test('conversation ownership, ordering, citation snapshots and cascades are enforced', async t => {
  const tenants = [];
  async function tenant() {
    const id = randomUUID();
    await prisma.user.create({ data: { id, name: 'History schema test', email: `${id}@example.invalid`, password: 'unused',
      memberships: { create: { role: 'MEMBER', organization: { create: { id, name: 'History schema test', slug: `history-${id}` } } } },
    } });
    tenants.push(id);
    return id;
  }
  try {
    const own = await tenant();
    const other = await tenant();
    const conversation = await prisma.conversation.create({ data: { organizationId: own, userId: own, title: 'Annual leave' } });

    // A real user from another organization cannot be assigned as this chat's owner.
    await assert.rejects(prisma.conversation.create({ data: { organizationId: own, userId: other, title: 'Wrong owner' } }), { code: 'P2003' });
    const questionData = { conversationId: conversation.id, organizationId: own, role: 'USER', content: 'How much annual leave?', sequence: 0 };
    const question = await prisma.message.create({ data: questionData });
    await assert.rejects(prisma.message.create({ data: { ...questionData, organizationId: other, sequence: 1 } }), { code: 'P2003' });
    await assert.rejects(prisma.message.create({ data: questionData }), { code: 'P2002' });
    // CHECK constraints supplement Prisma's enums with role-specific rules.
    for (const invalid of [
      { ...questionData, sequence: -1 },
      { ...questionData, sequence: 1, answerStatus: 'answered' },
      { ...questionData, sequence: 1, role: 'ASSISTANT' },
      { ...questionData, sequence: 1, content: ' ' },
      { ...questionData, sequence: 1, content: 'x'.repeat(1001) },
    ]) await assert.rejects(prisma.message.create({ data: invalid }));

    const answer = await prisma.message.create({ data: {
      conversationId: conversation.id, organizationId: own, role: 'ASSISTANT',
      content: '18 days [S1].', sequence: 1, answerStatus: 'answered',
    } });
    // Use an actual document/chunk, then remove it: historical metadata must survive.
    const document = await prisma.document.create({ data: {
      organizationId: own, uploadedById: own, name: 'test', originalName: 'policy.txt', mimeType: 'text/plain',
      size: 8, storagePath: 'unused-schema-test', status: 'COMPLETED',
      chunks: { create: { content: '18 days', chunkIndex: 0 } },
    }, include: { chunks: true } });
    const snapshot = { messageId: answer.id, organizationId: own, sourceId: 'S1',
      documentId: document.id, chunkId: document.chunks[0].id, documentName: document.originalName, chunkIndex: 0, similarity: 0.8 };
    await prisma.messageSource.create({ data: snapshot });
    await assert.rejects(prisma.messageSource.create({ data: snapshot }), { code: 'P2002' });
    await assert.rejects(prisma.messageSource.create({ data: { ...snapshot, sourceId: 'S2', organizationId: other } }), { code: 'P2003' });
    for (const invalid of [
      { ...snapshot, sourceId: '[S2]' }, { ...snapshot, sourceId: 'S2', chunkIndex: -1 },
      { ...snapshot, sourceId: 'S2', similarity: 2 },
    ]) await assert.rejects(prisma.messageSource.create({ data: invalid }));

    await prisma.document.delete({ where: { id: document.id } });
    const saved = await prisma.messageSource.findUniqueOrThrow({ where: { messageId_sourceId: { messageId: answer.id, sourceId: 'S1' } } });
    assert.equal(saved.documentName, 'policy.txt');
    assert.equal(saved.chunkId, snapshot.chunkId);
    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id, organizationId: own }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(messages.map(message => message.id), [question.id, answer.id]);

    // Membership removal intentionally cascades only that owner's history.
    const otherConversation = await prisma.conversation.create({ data: { organizationId: other, userId: other, title: 'Other organization' } });
    await prisma.organizationMember.delete({ where: { userId_organizationId: { userId: own, organizationId: own } } });
    assert.equal(await prisma.conversation.count({ where: { id: conversation.id } }), 0);
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 0);
    assert.equal(await prisma.messageSource.count({ where: { messageId: answer.id } }), 0);
    assert.equal(await prisma.conversation.count({ where: { id: otherConversation.id } }), 1);
    const indexes = await prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'DocumentChunk_embedding_idx'`;
    assert.equal(indexes.length, 1, 'The existing vector index must remain present');
    t.diagnostic('Verified composite tenant keys, role checks, ordering, snapshot survival, cascades and preserved HNSW index.');
  } finally {
    // Delete only the unique fixtures created by this test, including partial setup.
    try {
      for (const id of tenants) await prisma.$transaction([
        prisma.document.deleteMany({ where: { organizationId: id } }),
        prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
      ]);
    } finally { await prisma.$disconnect(); }
  }
});
