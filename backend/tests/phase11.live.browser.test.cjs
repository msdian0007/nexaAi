// Opt-in: real Chrome, frontend, HTTP routes, Redis, separate worker, PostgreSQL,
// local embeddings and ONE real Gemini answer. No route interception or AI stubs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');
const cors = require('cors');
const { Queue } = require('bullmq');
const prisma = require('../dist/src/config/database').default;
const { createDocumentQueue } = require('../dist/src/document/document.queue');
const { createRedisConnection } = require('../dist/src/config/redis');

test('Phase 11 live browser: queued upload, retry, cited answer, new-login history and isolation', {
  skip: process.env.RUN_LIVE_PHASE11_TEST !== '1', timeout: 300000,
}, async t => {
  const { chromium, expect } = require('../../frontend/node_modules/@playwright/test');
  const viteEntry = require.resolve('vite', { paths: [path.resolve('../frontend')] });
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  const runId = randomUUID();
  const queueName = `nexaai-live-browser-${runId}`;
  const accounts = [];
  const originalSecret = process.env.JWT_SECRET;
  const connection = createRedisConnection();
  let server, vite, browser, producer, inspector, child;
  try {
    assert.ok(process.env.GEMINI_API_KEY?.trim(), 'Configure GEMINI_API_KEY before the opt-in live test');
    process.env.JWT_SECRET = randomUUID();
    producer = await createDocumentQueue({ queueName });
    await connection.connect();
    inspector = new Queue(queueName, { connection });
    inspector.on('error', () => {});
    const app = express();
    app.use(cors());
    app.use(express.json());
    app.locals.getDocumentQueue = async () => producer;
    app.use('/api/v1/auth', require('../dist/src/auth/auth.routes').default);
    app.use('/api/v1/auth', require('../dist/src/auth/auth.protected.route').default);
    app.use('/api/v1/documents', require('../dist/src/document/document.routes').default);
    app.use('/api/v1/chat', require('../dist/src/rag/rag.routes').default);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function call(route, { token, body, status = 200 } = {}) {
      const response = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, status, `${route}: unexpected HTTP status`);
      return (await response.json()).data;
    }
    async function register(label) {
      const email = `${runId}-${label}@example.invalid`;
      const password = randomUUID();
      accounts.push(email);
      const data = await call('/auth/register', { status: 201, body: {
        email, password, name: 'Phase 11 Test', organizationName: `Phase11 ${runId} ${label}`,
      } });
      return { ...data, email, password };
    }
    const owner = await register('owner');
    const outsider = await register('outsider');
    vite = await createServer({
      root: path.resolve('../frontend'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false },
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(base) },
    });
    await vite.listen();
    const frontend = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    let statusChecks = 0;
    let generations = 0;
    page.on('request', request => {
      if (request.url().endsWith('/status')) statusChecks++;
      if (request.url().endsWith('/chat/query')) generations++;
    });
    async function login(account) {
      await page.goto(`${frontend}/login`);
      await page.getByLabel('Email address').fill(account.email);
      await page.getByLabel('Password', { exact: true }).fill(account.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Welcome, Phase 11 Test' })).toBeVisible();
    }
    async function upload(file) {
      await page.getByLabel('Select a document').setInputFiles(file);
      const responsePromise = page.waitForResponse(response => response.url() === `${base}/documents/upload`);
      await page.getByRole('button', { name: 'Upload document', exact: true }).click();
      const response = await responsePromise;
      assert.equal(response.status(), 202);
      return (await response.json()).data;
    }
    await login(owner);
    await page.getByRole('link', { name: 'Documents', exact: true }).click();
    const document = await upload(path.resolve('../samples/nexaai-employee-handbook.txt'));
    await expect(page.getByRole('status')).toContainText('Waiting for processing');
    assert.equal(await prisma.documentChunk.count({ where: { documentId: document.id } }), 0);
    assert.equal(await producer.getState({ documentId: document.id, organizationId: owner.organization.id }), 'waiting');
    t.diagnostic('Browser upload returned 202 while no worker ran; the document stayed queued with zero chunks.');

    child = fork(path.join(__dirname, 'fixtures/live-document-worker.cjs'), [queueName], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    await expect(page.getByRole('status')).toContainText('Ready for questions', { timeout: 120000 });
    assert.ok(statusChecks > 0, 'Readiness must arrive through real automatic polling');
    const vectors = await prisma.$queryRaw`SELECT vector_dims(embedding) AS dimensions FROM "DocumentChunk" WHERE "documentId" = ${document.id}`;
    assert.ok(vectors.length > 0 && vectors.every(row => row.dimensions === 384));
    t.diagnostic(`Separate worker completed the handbook; browser polling showed Ready (${vectors.length} real 384-dimensional vectors).`);

    // Real empty-text failure exercises three attempts, terminal UI and explicit retry.
    const broken = await upload({ name: 'fictional-empty.txt', mimeType: 'text/plain', buffer: Buffer.from('   \n') });
    await expect(page.getByRole('status')).toContainText('Processing failed', { timeout: 45000 });
    const failedJob = await inspector.getJob(`document-${owner.organization.id}-${broken.id}`);
    assert.equal(failedJob.attemptsMade, 3);
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: broken.id } });
    const tenantRoot = path.resolve('uploads', 'documents', owner.organization.id);
    const target = path.resolve(stored.storagePath);
    assert.equal(path.dirname(target), tenantRoot);
    await fs.writeFile(target, 'Fictional cafeteria schedule: lunch is served at noon.');
    await page.getByRole('button', { name: 'Retry processing', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Ready for questions', { timeout: 60000 });
    assert.equal(await prisma.document.count({ where: { organizationId: owner.organization.id } }), 2);
    t.diagnostic('Whitespace-only upload exhausted three attempts; repairing the fixture and clicking Retry recovered the same document.');

    await call(`/documents/${document.id}/status`, { token: outsider.token, status: 404 });
    await call(`/documents/${document.id}/reprocess`, { token: outsider.token, body: {}, status: 404 });
    const search = await call('/documents/search', { token: outsider.token, body: { query: 'paid annual leave', minSimilarity: 0 } });
    assert.deepEqual(search.results, []);
    t.diagnostic('Another organization cannot read status, retry the document, or retrieve its chunks.');

    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    const question = 'How many days of paid annual leave do full-time employees receive per calendar year?';
    await page.getByLabel('Your question').fill(question);
    const answerResponse = page.waitForResponse(response => response.url() === `${base}/chat/query`, { timeout: 65000 });
    await page.getByRole('button', { name: 'Ask question', exact: true }).click();
    const response = await answerResponse;
    const payload = await response.json();
    assert.equal(response.status(), 200, `Live Gemini query failed: ${payload.code || 'unknown'}`);
    const answer = payload.data;
    assert.equal(answer.status, 'answered');
    assert.match(answer.answer, /\b(?:18|eighteen)\b/i);
    assert.ok(answer.citations.length > 0);
    assert.ok(answer.citations.every(id => answer.sources.some(source => source.sourceId === id)));
    assert.ok(answer.sources.some(source => source.documentId === document.id && answer.citations.includes(source.sourceId)));
    await expect(page.locator('.answer-text')).toHaveText(answer.answer);
    await expect(page.getByRole('region', { name: 'Answer sources' })).toContainText('nexaai-employee-handbook.txt');
    t.diagnostic('One real Gemini answer said 18 annual leave days and cited the uploaded handbook.');

    // Sign out removes browser session state. Reopening must load saved messages;
    // the browser must not call generation a second time to reproduce the answer.
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await login(owner);
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.locator('.conversation-choice').first().click();
    await expect(page.locator('.answer-text')).toHaveText(answer.answer);
    await expect(page.getByRole('region', { name: 'Answer sources' })).toContainText('nexaai-employee-handbook.txt');
    assert.equal(generations, 1);
    const saved = await call(`/chat/conversations/${answer.conversationId}/messages`, { token: owner.token });
    assert.deepEqual(saved.messages.map(message => message.content), [question, answer.answer]);
    assert.deepEqual(saved.messages[1].sources, answer.sources);
    const hidden = await call('/chat/conversations', { token: outsider.token });
    assert.deepEqual(hidden.conversations, []);
    await call(`/chat/conversations/${answer.conversationId}/messages`, { token: outsider.token, status: 404 });
    await call('/chat/query', { token: outsider.token, status: 404, body: { question, conversationId: answer.conversationId } });
    assert.equal(await prisma.message.count({ where: { conversationId: answer.conversationId } }), 2);
    t.diagnostic('A fresh browser login reopened the identical saved answer/sources without regeneration; cross-organization history access was rejected.');
  } finally {
    // Close owned processes before deleting fixtures. Never touch the application queue.
    await browser?.close();
    await vite?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.send('stop');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await producer?.close();
    if (inspector) {
      assert.equal(queueName, `nexaai-live-browser-${runId}`);
      await inspector.obliterate({ force: true });
      await inspector.close();
    }
    connection.disconnect();
    try {
      for (const email of accounts) {
        const user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
        if (!user) continue;
        for (const membership of user.memberships) {
          const root = path.resolve('uploads', 'documents');
          const directory = path.resolve(root, membership.organizationId);
          assert.equal(path.dirname(directory), root);
          const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
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
      t.diagnostic('Removed temporary accounts, organizations, uploaded files, messages and the isolated Redis queue.');
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
    }
  }
});
