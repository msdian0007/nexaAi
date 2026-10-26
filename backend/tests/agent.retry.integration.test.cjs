// Real PostgreSQL and an isolated Redis/BullMQ queue. No files are processed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const prisma = require('../dist/src/config/database').default;
const { createDocumentQueue } = require('../dist/src/document/document.queue');
const { createRedisConnection, createWorkerRedisConnection } = require('../dist/src/config/redis');
const { proposeDocumentRetry, confirmDocumentRetry, cancelRetryProposal, readRetryProposal } = require('../dist/src/agents/retry.tool');
const { AgentMembershipError } = require('../dist/src/agents/agent.access');

test('retry proposals require separate current, version-bound, single-use confirmation', { timeout: 90000 }, async t => {
  const own = randomUUID(), foreign = randomUUID(), user = randomUUID(), peer = randomUUID(), outsider = randomUUID();
  const context = { userId: user, organizationId: own };
  const organizations = [], users = [];
  const queueName = `nexaai-agent-retry-${randomUUID()}`;
  let producer, inspector, connection;
  const queueFor = async () => producer;
  const input = documentId => ({ tool: 'retry_document', input: { documentId } });
  const confirm = id => ({ proposalId: id });
  const ids = document => ({ documentId: document.id, organizationId: document.organizationId });
  async function withDocument(run, organizationId = own) {
    const document = await prisma.document.create({ data: {
      organizationId, uploadedById: organizationId === own ? user : outsider,
      name: 'private-storage-name', originalName: 'handbook.txt', mimeType: 'text/plain', size: 12,
      storagePath: 'unused-test-file.txt', status: 'FAILED', errorMessage: 'private failure',
      chunks: { create: { chunkIndex: 0, content: 'Existing partial content', embeddingStatus: 'FAILED' } },
    } });
    try { await run(document); }
    finally {
      await (await inspector.getJob(`document-${organizationId}-${document.id}`))?.remove();
      await prisma.document.deleteMany({ where: { id: document.id, organizationId } });
    }
  }
  const propose = doc => proposeDocumentRetry(context, input(doc.id), queueFor);
  const receipt = id => prisma.agentRetryProposal.findUniqueOrThrow({ where: { id } });
  try {
    for (const id of [own, foreign]) {
      await prisma.organization.create({ data: { id, name: 'Action fixture', slug: `agent-action-${id}` } }); organizations.push(id);
    }
    for (const id of [user, peer, outsider]) {
      await prisma.user.create({ data: { id, name: 'Action fixture', email: `${id}@example.invalid`, password: 'unused' } }); users.push(id);
    }
    for (const userId of [user, peer]) await prisma.organizationMember.create({ data: { userId, organizationId: own, role: 'MEMBER' } });
    await prisma.organizationMember.create({ data: { userId: outsider, organizationId: foreign, role: 'OWNER' } });
    producer = await createDocumentQueue({ queueName });
    connection = createRedisConnection(); await connection.connect();
    inspector = new Queue(queueName, { connection }); inspector.on('error', () => {});

    await t.test('proposal only reads eligibility and returns a safe named preview with five-minute expiry', async () => withDocument(async doc => {
      const before = await prisma.document.findUniqueOrThrow({ where: { id: doc.id }, include: { chunks: true } });
      const started = Date.now(), p = await propose(doc);
      assert.equal(p.documentName, 'handbook.txt'); assert.equal(p.documentId, doc.id); assert.equal(p.state, 'PENDING');
      assert.equal(p.tool, 'retry_document');
      assert.ok(Date.parse(p.expiresAt) >= started + 299000 && Date.parse(p.expiresAt) <= Date.now() + 300000);
      assert.equal(JSON.stringify(p).includes('private'), false);
      assert.equal(await producer.getState(ids(doc)), 'unknown');
      assert.deepEqual(await prisma.document.findUniqueOrThrow({ where: { id: doc.id }, include: { chunks: true } }), before);
      assert.deepEqual(await readRetryProposal(context, confirm(p.id)), p);
    }));

    await t.test('confirmation queues a missing job once and replay remains blocked after the job is removed', async () => withDocument(async doc => {
      const p = await propose(doc);
      assert.deepEqual(await confirmDocumentRetry(context, confirm(p.id), queueFor), { tool: 'retry_document', data: { documentId: doc.id, state: 'accepted' } });
      assert.equal(await producer.getState(ids(doc)), 'waiting');
      assert.equal((await receipt(p.id)).state, 'ACCEPTED');
      await (await inspector.getJob(`document-${own}-${doc.id}`)).remove();
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'PROPOSAL_USED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('cancellation consumes a proposal without any queue write', async () => withDocument(async doc => {
      const p = await propose(doc);
      assert.equal((await cancelRetryProposal(context, confirm(p.id))).state, 'CANCELLED');
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'PROPOSAL_USED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('expired proposals cannot submit work', async () => withDocument(async doc => {
      const p = await propose(doc);
      await prisma.agentRetryProposal.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'PROPOSAL_EXPIRED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('changed document name/version invalidates the proposal', async () => withDocument(async doc => {
      const p = await propose(doc);
      await prisma.document.update({ where: { id: doc.id }, data: { originalName: 'new-handbook.txt' } });
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'DOCUMENT_CHANGED');
      assert.equal((await receipt(p.id)).state, 'REJECTED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('each current role can confirm; an unchanged filename does not bypass a changed version', async () => {
      try {
        for (const role of ['MEMBER', 'ADMIN', 'OWNER']) {
          await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role } });
          await withDocument(async doc => {
            const p = await propose(doc);
            await confirmDocumentRetry(context, confirm(p.id), queueFor);
            assert.equal(await producer.getState(ids(doc)), 'waiting');
          });
        }
        await withDocument(async doc => {
          const p = await propose(doc);
          await prisma.document.update({ where: { id: doc.id }, data: { updatedAt: new Date(Date.now() + 1000) } });
          await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'DOCUMENT_CHANGED');
          assert.equal(await producer.getState(ids(doc)), 'unknown');
        });
      } finally { await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: 'MEMBER' } }); }
    });

    await t.test('ready, deleting, deleted and already queued files are not submitted by old proposals', async () => {
      for (const change of ['ready', 'deleting', 'deleted', 'queued']) await withDocument(async doc => {
        const p = await propose(doc);
        if (change === 'ready') await prisma.document.update({ where: { id: doc.id }, data: { status: 'COMPLETED' } });
        if (change === 'deleting') await prisma.document.update({ where: { id: doc.id }, data: { deletionRequestedAt: new Date() } });
        if (change === 'deleted') await prisma.document.delete({ where: { id: doc.id } });
        if (change === 'queued') await producer.enqueue(ids(doc));
        await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor));
        assert.equal((await receipt(p.id)).state, 'REJECTED');
        assert.equal(await producer.getState(ids(doc)), change === 'queued' ? 'waiting' : 'unknown');
      });
    });

    await t.test('foreign and missing document IDs are indistinguishable and never access Redis', async () => withDocument(async doc => {
      let accessed = 0;
      const unavailable = async () => { accessed++; throw new Error('Must not connect'); };
      for (const id of [doc.id, randomUUID()]) await assert.rejects(proposeDocumentRetry(context, input(id), unavailable), error => error.code === 'DOCUMENT_UNAVAILABLE' && error.status === 404);
      assert.equal(accessed, 0);
    }, foreign));

    await t.test('a peer or other organization cannot inspect or confirm another user proposal; extra approval fields fail', async () => withDocument(async doc => {
      const p = await propose(doc);
      for (const other of [{ userId: peer, organizationId: own }, { userId: outsider, organizationId: foreign }]) {
        await assert.rejects(readRetryProposal(other, confirm(p.id)), error => error.status === 404);
        await assert.rejects(confirmDocumentRetry(other, confirm(p.id), queueFor), error => error.status === 404);
      }
      for (const body of [{ proposalId: p.id, confirmed: true }, { proposalId: p.id, documentId: doc.id }, { proposalId: p.id, organizationId: foreign }, {}, { proposalId: 'bad' }]) {
        await assert.rejects(confirmDocumentRetry(context, body, queueFor), error => error.code === 'INVALID_PROPOSAL_REQUEST');
      }
      assert.equal((await receipt(p.id)).state, 'PENDING');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('revoked membership denies confirmation and cascades outstanding proposals', async () => withDocument(async doc => {
      const p = await propose(doc);
      await prisma.organizationMember.delete({ where: { userId_organizationId: context } });
      try {
        await assert.rejects(confirmDocumentRetry({ ...context, role: 'OWNER' }, confirm(p.id), queueFor), AgentMembershipError);
        assert.equal(await prisma.agentRetryProposal.count({ where: { id: p.id } }), 0);
      } finally { await prisma.organizationMember.create({ data: { ...context, role: 'MEMBER' } }); }
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.status === 404);
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('simultaneous confirmations of the same proposal have only one winner', async () => withDocument(async doc => {
      const p = await propose(doc);
      const results = await Promise.allSettled([confirmDocumentRetry(context, confirm(p.id), queueFor), confirmDocumentRetry(context, confirm(p.id), queueFor)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      assert.equal(await inspector.getWaitingCount(), 1);
    }));

    await t.test('two proposals for the same file still submit only one eligible queue instruction', async () => withDocument(async doc => {
      const a = await propose(doc), b = await propose(doc);
      const results = await Promise.allSettled([confirmDocumentRetry(context, confirm(a.id), queueFor), confirmDocumentRetry(context, confirm(b.id), queueFor)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(await inspector.getWaitingCount(), 1);
    }));

    await t.test('a retained failed BullMQ job is retried and its attempt budget is reset', async () => withDocument(async doc => {
      await producer.enqueue(ids(doc));
      const workerConnection = createWorkerRedisConnection();
      const worker = new Worker(queueName, async () => { throw new UnrecoverableError('Fixture failure'); }, { connection: workerConnection });
      worker.on('error', () => {});
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && await producer.getState(ids(doc)) !== 'failed') await delay(50);
        assert.equal(await producer.getState(ids(doc)), 'failed');
      } finally { await worker.close(); workerConnection.disconnect(); }
      const p = await propose(doc);
      await confirmDocumentRetry(context, confirm(p.id), queueFor);
      assert.equal(await producer.getState(ids(doc)), 'waiting');
      assert.equal((await inspector.getJob(`document-${own}-${doc.id}`)).attemptsMade, 0);
    }));

    await t.test('lost acknowledgement leaves a consumed UNCERTAIN proposal; replay cannot requeue', async () => withDocument(async doc => {
      const p = await propose(doc);
      const lost = async () => ({ ...producer, enqueue: async value => { await producer.enqueue(value); throw new Error('Lost acknowledgement'); } });
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), lost), error => error.code === 'SUBMISSION_UNCONFIRMED');
      assert.equal((await receipt(p.id)).state, 'UNCERTAIN');
      assert.equal(await producer.getState(ids(doc)), 'waiting');
      await (await inspector.getJob(`document-${own}-${doc.id}`)).remove();
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'PROPOSAL_USED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('queue read failure consumes the attempt without queuing or claiming success', async () => withDocument(async doc => {
      const p = await propose(doc);
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), async () => { throw new Error('Unavailable'); }), error => error.code === 'QUEUE_UNAVAILABLE');
      assert.equal((await receipt(p.id)).state, 'REJECTED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('a durable CLAIMED receipt cannot run again after an interrupted attempt', async () => withDocument(async doc => {
      const p = await propose(doc);
      // Model the database state left after a process dies following its claim commit.
      await prisma.agentRetryProposal.update({ where: { id: p.id }, data: { state: 'CLAIMED', consumedAt: new Date() } });
      await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor), error => error.code === 'PROPOSAL_USED');
      assert.equal((await readRetryProposal(context, confirm(p.id))).state, 'CLAIMED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));

    await t.test('the existing worker/deletion advisory lock blocks confirmation without a queue write', async () => withDocument(async doc => {
      const p = await propose(doc);
      await prisma.$transaction(async tx => {
        const [locked] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${doc.id}, 0)) AS acquired`;
        assert.equal(locked.acquired, true);
        await assert.rejects(confirmDocumentRetry(context, confirm(p.id), queueFor));
      });
      assert.equal((await receipt(p.id)).state, 'REJECTED');
      assert.equal(await producer.getState(ids(doc)), 'unknown');
    }));
  } finally {
    try {
      await producer?.close();
      if (inspector) {
        assert.match(queueName, /^nexaai-agent-retry-[0-9a-f-]{36}$/);
        await inspector.obliterate(); await inspector.close();
      }
    } finally {
      connection?.disconnect();
      try {
        await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
      } finally { await prisma.$disconnect(); }
    }
  }
});
