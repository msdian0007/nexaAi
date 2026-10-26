// Isolated real auth + dashboard API for Chrome. No model, embeddings or Redis.
// Test-only mutations travel over the child process IPC channel, never HTTP.
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const prisma = require('../../dist/src/config/database').default;

async function startDashboardFixture({ fullApi = false } = {}) {
  const org = randomUUID(), foreign = randomUUID(), secret = randomUUID();
  const user = randomUUID(), peer = randomUUID(), outsider = randomUUID();
  const organizations = [org, foreign, secret], users = [user, peer, outsider];
  const priorSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  const password = 'DashboardFixture123!';
  const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const day = offset => new Date(today + offset * 86400000).toISOString().slice(0, 10);
  const at = (offset, time = '00:00:00.000') => new Date(`${day(offset)}T${time}Z`);
  const context = { userId: user, organizationId: org };
  let server, conversation, failedDocument;
  let added = false;

  async function stop() {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      if (fullApi) for (const id of organizations) {
        const root = path.resolve('uploads', 'documents', id);
        assert.equal(path.dirname(root), path.resolve('uploads', 'documents'));
        // Boundary browser cases submit rejected uploads only. Never recursively
        // delete an unexpected file: a nonempty directory should fail cleanup.
        await fs.rmdir(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      // Exact generated IDs only: never truncate shared developer tables.
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      assert.equal(await prisma.organization.count({ where: { id: { in: organizations } } }), 0);
      assert.equal(await prisma.user.count({ where: { id: { in: users } } }), 0);
      // Cascades must also remove every fixture's private activity and documents.
      for (const model of [prisma.document, prisma.conversation, prisma.message, prisma.agentExecution])
        assert.equal(await model.count({ where: { organizationId: { in: organizations } } }), 0);
    } finally {
      if (priorSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = priorSecret;
      await prisma.$disconnect();
    }
  }
  async function document(organizationId, uploadedById, status, offset, deleting = false) {
    return prisma.document.create({ data: { organizationId, uploadedById, status,
      name: 'fixture-private-storage-name', originalName: 'fixture-private-name.txt',
      mimeType: 'text/plain', size: 5, storagePath: 'fixture/private/path', extractedText: 'fixture private document text',
      createdAt: at(offset, '12:00:00.000'), deletionRequestedAt: deleting ? new Date() : null } });
  }
  async function execution(userId, organizationId, outcome, offset, operation = 'REQUEST', time = '12:00:00.000') {
    return prisma.agentExecution.create({ data: { userId, organizationId, outcome, operation, startedAt: at(offset, time) } });
  }
  async function message(c, sequence, role, offset, time = '12:00:00.000') {
    return prisma.message.create({ data: { conversationId: c.id, organizationId: c.organizationId,
      sequence, role, content: 'fixture private chat text', createdAt: at(offset, time),
      ...(role === 'ASSISTANT' ? { answerStatus: 'insufficient_information' } : {}) } });
  }
  try {
    for (const [id, name] of [[org, 'Dashboard Support'], [foreign, 'Dashboard Sales'], [secret, 'Dashboard Unrelated']])
      await prisma.organization.create({ data: { id, name, slug: `dashboard-live-${id}` } });
    const hash = await bcrypt.hash(password, 4);
    for (const [id, name] of [[user, 'Dashboard Owner'], [peer, 'Dashboard Teammate'], [outsider, 'Dashboard Outsider']])
      await prisma.user.create({ data: { id, name, email: `${id}@example.invalid`, password: hash } });
    for (const [userId, organizationId, role, offset] of [[user, org, 'OWNER', -100], [user, foreign, 'MEMBER', -99], [peer, org, 'MEMBER', -100], [outsider, secret, 'OWNER', -100]])
      await prisma.organizationMember.create({ data: { userId, organizationId, role, createdAt: at(offset) } });

    await document(org, user, 'COMPLETED', -10); // Current, outside default activity dates.
    await document(org, peer, 'PROCESSING', -2);
    failedDocument = await document(org, peer, 'FAILED', -1);
    await document(org, user, 'UPLOADED', 0);
    await document(org, peer, 'FAILED', -1, true); // Pending deletion never counts.
    await document(foreign, user, 'COMPLETED', 0);
    await document(foreign, user, 'FAILED', 0);
    await document(secret, outsider, 'FAILED', -1);

    conversation = await prisma.conversation.create({ data: { ...context, title: 'fixture private owner title', createdAt: at(-20) } });
    // Exact boundaries distinguish [from, to) from local dates or inclusive 'to'.
    for (const [sequence, offset, time] of [[0, -3, '23:59:59.999'], [2, -1, '00:00:00.000'], [4, 0, '23:59:59.999'], [6, 1, '00:00:00.000']]) {
      await message(conversation, sequence, 'USER', offset, time);
      await message(conversation, sequence + 1, 'ASSISTANT', offset, time);
    }
    await execution(user, org, 'SUCCEEDED', -3, 'REQUEST', '23:59:59.999');
    await execution(user, org, 'SUCCEEDED', -1, 'REQUEST', '00:00:00.000');
    for (const outcome of ['FAILED', 'STARTED', 'UNCONFIRMED']) await execution(user, org, outcome, 0, 'REQUEST', '23:59:59.999');
    await execution(user, org, 'SUCCEEDED', 1, 'REQUEST', '00:00:00.000');
    for (const operation of ['CONFIRM', 'CANCEL']) await execution(user, org, 'SUCCEEDED', -1, operation);
    for (const [userId, organizationId, questionCount, requestCount] of [[peer, org, 3, 7], [user, foreign, 1, 2], [outsider, secret, 6, 9]]) {
      const c = await prisma.conversation.create({ data: { userId, organizationId, title: 'fixture private other title' } });
      for (let i = 0; i < questionCount; i++) await message(c, i, 'USER', organizationId === org ? -1 : 0);
      for (let i = 0; i < requestCount; i++) await execution(userId, organizationId, organizationId === org ? 'FAILED' : 'SUCCEEDED', organizationId === org ? -1 : 0);
    }
    const app = fullApi ? require('../../dist/src/api').createApiApp({ origins: ['http://127.0.0.1:4173'] }) : express();
    if (fullApi) app.locals.getDocumentQueue = async () => { throw new Error('Fixture queue unavailable'); };
    else {
      app.use(cors()); app.use(express.json());
      app.use('/api/v1/auth', require('../../dist/src/auth/auth.routes').default);
      app.use('/api/v1/auth', require('../../dist/src/auth/auth.protected.route').default);
      const analytics = require('../../dist/src/analytics/dashboard.routes');
      app.use('/api/v1/analytics', analytics.default, analytics.dashboardJsonError);
    }
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    async function control(command) {
      if (command === 'add-activity' && !added) {
        added = true;
        await document(org, user, 'UPLOADED', 0);
        await message(conversation, 100, 'USER', 0);
        await execution(user, org, 'SUCCEEDED', 0);
      } else if (command === 'delete-retained') {
        await prisma.document.delete({ where: { id: failedDocument.id } });
        await prisma.conversation.delete({ where: { id: conversation.id } });
      } else if (command === 'revoke') {
        await prisma.organizationMember.delete({ where: { userId_organizationId: context } });
      } else if (command === 'member' || command === 'admin') {
        await prisma.organizationMember.update({ where: { userId_organizationId: context }, data: { role: command.toUpperCase() } });
      } else throw new Error('Unknown fixture command');
    }
    return { stop, control, ready: { baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
      email: `${user}@example.invalid`, peerEmail: `${peer}@example.invalid`, password,
      userId: user, peerId: peer, organizationId: org, foreignId: foreign, secretId: secret,
      from: day(-2), yesterday: day(-1), through: day(0), to: day(1), emptyFrom: day(-30), emptyThrough: day(-29) } };
  } catch (error) { await stop(); throw error; }
}
module.exports = { startDashboardFixture };

if (require.main === module) {
  let stopping = false;
  void startDashboardFixture({ fullApi: process.argv.includes('--full-api') }).then(fixture => {
    process.send({ ready: true, ...fixture.ready });
    async function stop(replyTo) {
      if (stopping) return;
      stopping = true;
      try {
        await fixture.stop();
        if (process.connected) process.send({ replyTo, ok: true, cleaned: true }, () => process.exit(0));
        else process.exit(0);
      } catch { process.exit(1); }
    }
    // Serialize commands; a mutation reply means its database writes committed.
    let pending = Promise.resolve();
    process.on('message', message => {
      pending = pending.then(async () => {
        if (message.command === 'stop') return stop(message.id);
        try { await fixture.control(message.command); process.send({ replyTo: message.id, ok: true }); }
        catch { process.send({ replyTo: message.id, ok: false }); }
      });
    });
    process.once('disconnect', () => void stop());
    process.once('SIGTERM', () => void stop());
  }).catch(() => { process.stderr.write('Dashboard fixture startup failed.\n'); process.exitCode = 1; });
}
