// Opt-in integration check: real HTTP routes, PostgreSQL, local embeddings and Gemini.
// Run from backend after building. Only fictional, uniquely named fixtures are used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const prisma = require('../dist/src/config/database').default;

test('live upload and answers survive a new login and remain private', {
  skip: process.env.RUN_LIVE_CONVERSATION_TEST !== '1', timeout: 240000,
}, async t => {
  const runId = randomUUID();
  const accounts = [];
  const originalSecret = process.env.JWT_SECRET;
  let server;
  try {
    assert.ok(process.env.GEMINI_API_KEY?.trim(), 'GEMINI_API_KEY must be configured');
    // A temporary signing secret isolates test sessions without changing .env.
    process.env.JWT_SECRET = randomUUID();
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', require('../dist/src/auth/auth.routes').default);
    app.use('/api/v1/auth', require('../dist/src/auth/auth.protected.route').default);
    app.use('/api/v1/documents', require('../dist/src/document/document.routes').default);
    app.use('/api/v1/chat', require('../dist/src/rag/rag.routes').default);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;

    async function call(route, { token, body, status = 200 } = {}) {
      const multipart = body instanceof FormData;
      const response = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}),
        },
        body: multipart ? body : body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(150000),
      });
      const payload = await response.json();
      // Never include auth response bodies or tokens in assertion diagnostics.
      assert.equal(response.status, status, `${route}: unexpected HTTP status; code=${payload.code || 'none'}`);
      if (status < 400) assert.equal(payload.success, true);
      return payload.data;
    }

    async function register(label) {
      const email = `${runId}-${label}@example.invalid`;
      const password = randomUUID();
      // Track the unique email before registration, including partial setup failures.
      accounts.push(email);
      const data = await call('/auth/register', { status: 201, body: {
        name: 'Live history test', email, password, organizationName: `History ${runId} ${label}`,
      } });
      return { ...data, email, password };
    }
    const owner = await register('owner');
    let session = await call('/auth/login', { body: { email: owner.email, password: owner.password } });
    const identity = await call('/auth/me', { token: session.token });
    assert.equal(identity.userId, owner.user.id);
    assert.equal(identity.organizationId, owner.organization.id);
    t.diagnostic('Registration, password login and authenticated identity passed.');

    const form = new FormData();
    form.append('document', new Blob([
      'Fictional NexaAI test leave policy. Employees receive 18 days of paid annual leave per year. ' +
      'Employees must submit annual leave requests to their manager at least 7 days before the planned absence.',
    ], { type: 'text/plain' }), 'fictional-history-policy.txt');
    const document = await call('/documents/upload', { token: session.token, body: form, status: 201 });
    assert.equal(document.status, 'COMPLETED');
    const processed = await call(`/documents/${document.id}/status`, { token: session.token });
    assert.equal(processed.status, 'COMPLETED');
    t.diagnostic('Fictional TXT upload, extraction and local embeddings completed.');

    const firstQuestion = 'How many days of paid annual leave do employees receive per year?';
    const first = await call('/chat/query', { token: session.token, body: { question: firstQuestion } });
    function verifyAnswer(answer, expected) {
      assert.equal(answer.status, 'answered');
      assert.match(answer.answer, expected);
      assert.ok(answer.citations.length > 0);
      assert.ok(answer.sources.length > 0);
      assert.ok(answer.sources.every(source => source.documentId === document.id));
      assert.ok(answer.citations.every(id => answer.sources.some(source => source.sourceId === id)));
    }
    verifyAnswer(first, /\b(?:18|eighteen)\b/i);
    const conversationId = first.conversationId;
    t.diagnostic('First live Gemini answer was cited and saved.');

    // Discard the first session and authenticate again. History must come from the
    // database, with no message objects supplied by the client and no generation call.
    session = await call('/auth/login', { body: { email: owner.email, password: owner.password } });
    const summaries = await call('/chat/conversations', { token: session.token });
    assert.deepEqual(summaries.conversations.map(item => item.id), [conversationId]);
    const reopened = await call(`/chat/conversations/${conversationId}/messages`, { token: session.token });
    assert.deepEqual(reopened.messages.map(item => item.id), [first.userMessageId, first.assistantMessageId]);
    assert.equal(reopened.messages[0].content, firstQuestion);
    assert.equal(reopened.messages[1].content, first.answer);
    assert.deepEqual(reopened.messages[1].sources, first.sources);

    const secondQuestion = 'How many days before a planned absence must employees submit annual leave requests?';
    const second = await call('/chat/query', { token: session.token, body: { question: secondQuestion, conversationId } });
    verifyAnswer(second, /\b(?:7|seven)\b/i);
    assert.equal(second.conversationId, conversationId);
    const saved = await call(`/chat/conversations/${conversationId}/messages`, { token: session.token });
    assert.deepEqual(saved.messages.map(item => item.sequence), [0, 1, 2, 3]);
    assert.deepEqual(saved.messages.map(item => item.content), [firstQuestion, first.answer, secondQuestion, second.answer]);
    assert.deepEqual(saved.messages[3].sources, second.sources);
    assert.equal(await prisma.conversation.count({ where: { userId: owner.user.id, organizationId: owner.organization.id } }), 1);
    assert.equal(await prisma.message.count({ where: { conversationId } }), 4);
    t.diagnostic('New login reopened saved sources; continuation produced one conversation with four ordered messages.');

    const outsider = await register('outsider');
    const hidden = await call('/chat/conversations', { token: outsider.token });
    assert.deepEqual(hidden.conversations, []);
    await call(`/chat/conversations/${conversationId}/messages`, { token: outsider.token, status: 404 });
    await call('/chat/query', { token: outsider.token, body: { question: firstQuestion, conversationId }, status: 404 });
    assert.equal(await prisma.message.count({ where: { conversationId } }), 4);
    t.diagnostic('Another organization cannot list, read or append to the conversation.');
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const email of accounts) {
        const user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
        if (!user) continue;
        for (const membership of user.memberships) {
          // Verify the resolved tenant directory before removing only its direct files.
          // Never remove the shared upload root or any other organization's files.
          assert.match(membership.organizationId, /^[0-9a-f-]{36}$/i);
          const uploadRoot = path.resolve('uploads', 'documents');
          const directory = path.resolve(uploadRoot, membership.organizationId);
          assert.equal(path.dirname(directory), uploadRoot);
          const files = await fs.readdir(directory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          for (const file of files) {
            const target = path.resolve(directory, file);
            assert.equal(path.dirname(target), directory);
            await fs.unlink(target);
          }
          await fs.rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await prisma.organization.delete({ where: { id: membership.organizationId } });
        }
        await prisma.user.delete({ where: { id: user.id } });
      }
      t.diagnostic('Removed this run\'s test accounts, organizations, conversations and uploaded files.');
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
    }
  }
});
