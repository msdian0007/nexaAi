// Real PostgreSQL aggregates, snapshot isolation, read-only enforcement and timeout.
// No Redis, embedding model, provider, HTTP route or browser is required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const prisma = require('../dist/src/config/database').default;
const { executeDocumentCountsTool } = require('../dist/src/agents/document-counts.tool');
const { AgentContractError } = require('../dist/src/agents/agent.contracts');
const { AgentIdentityError, AgentMembershipError } = require('../dist/src/agents/agent.access');
const proposal = { tool: 'document_counts', input: {} };
const zeros = { UPLOADED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };

test('document counts are scoped, consistent, bounded and read-only', { timeout: 90000 }, async t => {
  const own = randomUUID(), foreign = randomUUID(), empty = randomUUID();
  const user = randomUUID(), outsider = randomUUID();
  const organizations = [], users = [];
  const context = { userId: user, organizationId: own };
  const expected = { UPLOADED: 1, PROCESSING: 1, COMPLETED: 2, FAILED: 1 };
  const originalTransaction = prisma.$transaction;
  async function seed(organizationId, status, deleting = false) {
    return prisma.document.create({ data: {
      organizationId, uploadedById: organizationId === foreign ? outsider : user,
      status, deletionRequestedAt: deleting ? new Date() : null,
      name: 'private-storage-name', originalName: 'private-filename.txt', mimeType: 'text/plain', size: 12,
      storagePath: 'private/storage/path', extractedText: 'private extracted text', errorMessage: 'private exception',
    } });
  }
  // Instrument only the aggregate boundary; the transaction, membership lookup,
  // isolation and SQL commands remain real. Always restore the shared client.
  async function interceptAggregate(intercept, run) {
    prisma.$transaction = (work, options) => originalTransaction.call(prisma, tx => work({
      $executeRaw: tx.$executeRaw.bind(tx), organizationMember: tx.organizationMember,
      document: { groupBy: args => intercept(tx, args) },
    }), options);
    try { return await run(); } finally { prisma.$transaction = originalTransaction; }
  }
  try {
    for (const id of [own, foreign, empty]) {
      await prisma.organization.create({ data: { id, name: 'Agent counts fixture', slug: `agent-counts-${id}` } });
      organizations.push(id);
    }
    for (const id of [user, outsider]) {
      await prisma.user.create({ data: { id, name: 'Counts fixture', email: `${id}@example.invalid`, password: 'unused' } });
      users.push(id);
    }
    for (const organizationId of [own, empty]) await prisma.organizationMember.create({ data: { userId: user, organizationId, role: 'MEMBER' } });
    await prisma.organizationMember.create({ data: { userId: outsider, organizationId: foreign, role: 'OWNER' } });
    for (const [status, count] of Object.entries(expected)) {
      for (let i = 0; i < count; i++) await seed(own, status);
      await seed(own, status, true);
      await seed(foreign, status);
      await seed(foreign, status);
    }

    await t.test('all current roles receive exact counts excluding foreign and deleting documents', async () => {
      for (const role of ['MEMBER', 'ADMIN', 'OWNER']) {
        await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role } });
        const start = Date.now();
        const result = await executeDocumentCountsTool(context, proposal);
        assert.equal(result.tool, 'document_counts');
        assert.deepEqual(result.data.byStatus, expected);
        assert.equal(result.data.total, 5);
        assert.deepEqual(Object.keys(result.data).sort(), ['asOf', 'byStatus', 'total']);
        assert.ok(Date.parse(result.data.asOf) >= start && Date.parse(result.data.asOf) <= Date.now());
        assert.equal(new Date(result.data.asOf).toISOString(), result.data.asOf);
        for (const hidden of ['private', 'documentId', own, foreign, user, 'sources', 'citations']) {
          assert.equal(JSON.stringify(result).includes(hidden), false);
        }
      }
      await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'MEMBER' } });
    });

    await t.test('an empty organization returns four explicit zero counters', async () => {
      const result = await executeDocumentCountsTool({ userId: user, organizationId: empty }, proposal);
      assert.deepEqual(result.data.byStatus, zeros);
      assert.equal(result.data.total, 0);
    });

    await t.test('invalid context and model arguments cannot start a transaction', async () => {
      let opened = 0;
      prisma.$transaction = () => { opened++; throw new Error('Unexpected transaction'); };
      try {
        for (const invalid of [null, {}, [], { userId: user }, { ...context, organizationId: 'bad' }]) {
          await assert.rejects(executeDocumentCountsTool(invalid, proposal), AgentIdentityError);
        }
        for (const input of [{ organizationId: foreign }, { userId: outsider }, { role: 'OWNER' },
          { sql: 'SELECT * FROM "User"' }, { status: 'FAILED' }, { limit: 999999 }, { startDate: '2026-01-01' }]) {
          await assert.rejects(executeDocumentCountsTool(context, { tool: 'document_counts', input }), AgentContractError);
        }
        await assert.rejects(executeDocumentCountsTool(context, { tool: 'knowledge_answer', input: { question: 'Question?' } }), AgentContractError);
        assert.equal(opened, 0);
      } finally { prisma.$transaction = originalTransaction; }
    });

    await t.test('an outsider or removed member is denied before any aggregate despite old role claims', async () => {
      let aggregates = 0;
      await interceptAggregate(async () => { aggregates++; throw new Error('Unexpected aggregate'); }, async () => {
        await assert.rejects(executeDocumentCountsTool({ userId: outsider, organizationId: own, role: 'OWNER' }, proposal), AgentMembershipError);
        await prisma.organizationMember.delete({ where: { userId_organizationId: context } });
        try {
          await assert.rejects(executeDocumentCountsTool({ ...context, role: 'OWNER' }, proposal), AgentMembershipError);
        } finally {
          await prisma.organizationMember.create({ data: { ...context, role: 'MEMBER' } });
        }
      });
      assert.equal(aggregates, 0);
    });

    await t.test('membership and counts share a snapshot even when another connection inserts a document', async () => {
      let added;
      try {
        await interceptAggregate(async (tx, args) => {
          added = await seed(own, 'FAILED');
          return tx.document.groupBy(args);
        }, async () => {
          assert.deepEqual((await executeDocumentCountsTool(context, proposal)).data.byStatus, expected);
        });
        const next = await executeDocumentCountsTool(context, proposal);
        assert.equal(next.data.byStatus.FAILED, expected.FAILED + 1);
        assert.equal(next.data.total, 6);
      } finally {
        if (added) await prisma.document.delete({ where: { id: added.id } });
      }
    });

    await t.test('PostgreSQL rejects an accidental write inside the counts transaction', async () => {
      await interceptAggregate(async tx => {
        await tx.document.updateMany({ where: { organizationId: own }, data: { errorMessage: 'must-not-write' } });
      }, async () => {
        await assert.rejects(executeDocumentCountsTool(context, proposal), /read.only/i);
      });
      assert.equal(await prisma.document.count({ where: { organizationId: own, errorMessage: 'must-not-write' } }), 0);
    });

    await t.test('a slow statement is cancelled instead of returning zero or retrying', async () => {
      let attempts = 0;
      const started = performance.now();
      await interceptAggregate(async tx => {
        attempts++;
        // A deliberately slow read verifies the real database timeout without
        // locking shared tables or delaying other users' document operations.
        return tx.$queryRaw`SELECT pg_sleep(10)`;
      }, async () => {
        await assert.rejects(executeDocumentCountsTool(context, proposal), /timeout|expired|canceling statement/i);
      });
      assert.equal(attempts, 1);
      assert.ok(performance.now() - started < 15000);
      assert.deepEqual((await executeDocumentCountsTool(context, proposal)).data.byStatus, expected);
    });

    await t.test('a read failure propagates without a fabricated empty result or automatic retry', async () => {
      const failure = new Error('Controlled aggregate failure');
      let attempts = 0;
      await interceptAggregate(async () => { attempts++; throw failure; }, async () => {
        await assert.rejects(executeDocumentCountsTool(context, proposal), error => error === failure);
      });
      assert.equal(attempts, 1);
    });

    await t.test('successful counting leaves document records and private history unchanged', async () => {
      const before = await prisma.document.findMany({ where: { organizationId: own }, orderBy: { id: 'asc' } });
      await executeDocumentCountsTool(context, proposal);
      assert.deepEqual(await prisma.document.findMany({ where: { organizationId: own }, orderBy: { id: 'asc' } }), before);
      assert.equal(await prisma.conversation.count({ where: { organizationId: own } }), 0);
      assert.equal(await prisma.message.count({ where: { organizationId: own } }), 0);
    });

    await t.test('the counts path does not load Redis, embedding or provider modules', async () => {
      const loaded = Object.keys(require.cache).map(path => path.replaceAll('\\', '/'));
      for (const suffix of ['/config/redis.js', '/document/document.embedding.js', '/rag/gemini.provider.js']) {
        assert.equal(loaded.some(path => path.endsWith(suffix)), false);
      }
    });
  } finally {
    prisma.$transaction = originalTransaction;
    try {
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally { await prisma.$disconnect(); }
  }
});
