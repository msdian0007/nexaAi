// Actual production app factory, PostgreSQL, JWTs and disk uploads. Only queue
// acceptance is controlled: these checks verify admission, not worker execution.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcrypt');
const express = require('express');
const prisma = require('../dist/src/config/database').default;
const { createApiApp } = require('../dist/src/api');
const { issueAuthToken } = require('../dist/src/auth/auth.tokens');
const { installApiBoundary, apiError, allowedOrigins } = require('../dist/src/http/api.boundary');
const MAX = 10 * 1024 * 1024;

test('production API request boundaries, safe errors, origins and bounded uploads', { timeout: 120000 }, async t => {
  const user = randomUUID(), outsider = randomUUID(), org = randomUUID(), foreign = randomUUID();
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  const origin = 'http://127.0.0.1:4173';
  const root = path.resolve('uploads', 'documents', org);
  const originalUserRead = prisma.user.findUnique, originalTransaction = prisma.$transaction;
  let server, errorsServer;
  const enqueued = [];
  const email = `${user}@example.invalid`, password = 'x'.repeat(72);
  const context = { userId: user, organizationId: org };
  async function files() { try { return (await fs.readdir(root)).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  try {
    for (const id of [org, foreign]) await prisma.organization.create({ data: { id, name: 'Boundary fixture', slug: `boundary-${id}` } });
    for (const id of [user, outsider]) await prisma.user.create({ data: { id, name: 'Boundary fixture', email: `${id}@example.invalid`, password: await bcrypt.hash(password, 4) } });
    for (const [userId, organizationId] of [[user, org], [outsider, foreign]]) await prisma.organizationMember.create({ data: { userId, organizationId, role: 'OWNER' } });
    const token = issueAuthToken({ ...context, role: 'OWNER' }).token;
    const foreignToken = issueAuthToken({ userId: outsider, organizationId: foreign, role: 'OWNER' }).token;
    const app = createApiApp({ origins: [origin] });
    app.locals.getDocumentQueue = async () => ({ enqueue: async job => { enqueued.push(job); return { accepted: true }; }, getState: async () => 'waiting' });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function call(route, options = {}) {
      const response = await fetch(base + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-powered-by'), null);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const body = response.status === 204 ? null : await response.json();
      return { status: response.status, headers: response.headers, body };
    }
    const json = (body, headers = {}) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
    function form(bytes = 'Boundary fixture document text.', filename = 'policy.txt', type = 'text/plain') {
      const body = new FormData(); body.append('document', new Blob([bytes], { type }), filename); return body;
    }
    const upload = body => call('/documents/upload', { method: 'POST', body });
    let saved;
    await t.test('origin configuration accepts exact origins and requires explicit production configuration', () => {
      assert.deepEqual(allowedOrigins('https://app.example.invalid,http://localhost:5173'), ['https://app.example.invalid', 'http://localhost:5173']);
      for (const value of ['', '*', 'null', 'https://app.example.invalid/path', 'https://user:secret@example.invalid', 'ftp://example.invalid']) assert.throws(() => allowedOrigins(value));
      const priorMode = process.env.NODE_ENV, priorOrigins = process.env.API_ALLOWED_ORIGINS;
      try { process.env.NODE_ENV = 'production'; delete process.env.API_ALLOWED_ORIGINS; assert.throws(() => allowedOrigins(), /required/); }
      finally { if (priorMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorMode; if (priorOrigins === undefined) delete process.env.API_ALLOWED_ORIGINS; else process.env.API_ALLOWED_ORIGINS = priorOrigins; }
    });
    await t.test('allowed browser preflight and authenticated response carry exact origin without cookie credentials', async () => {
      const preflight = await call('/auth/me', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
      const me = await call('/auth/me', { headers: { Origin: origin } });
      assert.equal(me.status, 200); assert.equal(me.headers.get('access-control-allow-origin'), origin);
      assert.match(me.headers.get('vary'), /Origin/);
      assert.equal((await call('/auth/me')).status, 200);
    });
    await t.test('foreign/null/lookalike origins are denied before login or upload side effects', async () => {
      const before = await files();
      for (const Origin of ['https://untrusted.example.invalid', 'null', origin + '.evil.invalid']) {
        const result = await call('/auth/login', json({ email, password }, { Origin }));
        assert.equal(result.status, 403); assert.equal(result.body.code, 'ORIGIN_NOT_ALLOWED');
        assert.equal(result.headers.get('access-control-allow-origin'), null);
      }
      assert.equal((await call('/documents/upload', { method: 'POST', body: form(), headers: { Origin: 'https://untrusted.example.invalid' } })).status, 403);
      assert.deepEqual(await files(), before); assert.equal(enqueued.length, 0);
    });
    await t.test('oversized/malformed/compressed JSON, wrong media types and unknown routes get safe JSON', async () => {
      for (const [route, options, status] of [
        ['/documents/search', json({ query: 'x'.repeat(33000) }), 413],
        ['/documents/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }, 400],
        ['/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'private text' }, 415],
        ['/documents/search', { ...json({ query: 'test' }), headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }, 415],
        ['/documents/%ZZ/status', {}, 400], ['/does-not-exist', {}, 404],
      ]) {
        const result = await call(route, options); assert.equal(result.status, status);
        assert.equal(result.body.success, false);
        for (const text of ['SyntaxError', 'node_modules', 'private text', 'stack']) assert.equal(JSON.stringify(result.body).includes(text), false);
      }
    });
    await t.test('auth rejects wrong types, extra fields and bcrypt-truncated passwords before account reads', async () => {
      let reads = 0;
      prisma.user.findUnique = async () => { reads++; throw new Error('must not access account'); };
      try {
        for (const body of [{ email: 42, password }, { email: 'a\0@example.invalid', password }, { email, password: {} }, { email, password, role: 'OWNER' }, { email, password: 'x'.repeat(73) }, { email, password: '😀'.repeat(20) }])
          assert.equal((await call('/auth/login', json(body))).status, 400);
        assert.equal((await call('/auth/register', json({ name: '  ', organizationName: 'Team', email, password }))).status, 400);
        assert.equal(reads, 0);
      } finally { prisma.user.findUnique = originalUserRead; }
    });
    await t.test('invalid credentials and duplicate registration are safe; DB failures are 503 without internal details', async () => {
      assert.equal((await call('/auth/login', json({ email, password }))).status, 200);
      const wrong = await call('/auth/login', json({ email, password: 'wrong-password' }));
      const unknown = await call('/auth/login', json({ email: `${randomUUID()}@example.invalid`, password }));
      assert.equal(wrong.status, 401); assert.deepEqual(wrong.body, unknown.body);
      const duplicate = await call('/auth/register', json({ name: 'Fixture', organizationName: 'Team', email, password }));
      assert.equal(duplicate.status, 409);
      prisma.user.findUnique = async () => { throw new Error('private SQL connection password'); };
      try {
        const result = await call('/auth/login', json({ email, password }));
        assert.equal(result.status, 503); assert.equal(result.body.code, 'AUTH_UNAVAILABLE');
        assert.equal(JSON.stringify(result.body).includes('private'), false);
      } finally { prisma.user.findUnique = originalUserRead; }
    });
    await t.test('all API families reject identity overrides and unknown fields', async () => {
      for (const [route, options] of [
        ['/auth/me?organizationId=' + foreign, {}], ['/organizations/members?userId=' + outsider, {}],
        ['/organizations/members', json({ email, role: 'MEMBER', organizationId: foreign })],
        ['/chat/query', json({ question: 'Question?', organizationId: foreign })],
        ['/chat/conversations?role=OWNER', {}], ['/documents/search', json({ query: 'Question?', userId: outsider })],
        ['/documents?organizationId=' + foreign, {}], ['/agents/requests', json({ message: 'Question?', userId: outsider })],
        ['/analytics/summary?organizationId=' + foreign, {}],
      ]) assert.equal((await call(route, options)).status, 400, route);
    });
    await t.test('empty/binary/mismatched upload files and malformed multipart leave no file or record', async () => {
      const before = await files();
      for (const [bytes, filename, type, status] of [
        ['', 'empty.txt', 'text/plain', 400], ['plain text', 'renamed.pdf', 'application/pdf', 415],
        ['plain text', 'renamed.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 415],
        ['plain text', 'policy.txt', 'application/pdf', 415], [Buffer.from([0, 0xff, 0x4d, 0x5a]), 'binary.txt', 'text/plain', 415],
      ]) assert.equal((await upload(form(bytes, filename, type))).status, status);
      const malformed = await call('/documents/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'incomplete' });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await files(), before);
      assert.equal(await prisma.document.count({ where: { organizationId: org } }), 0); assert.equal(enqueued.length, 0);
    });
    await t.test('multipart cardinality and 10 MiB limits are enforced with partial-file cleanup', async () => {
      const before = await files();
      const extra = form(); extra.append('organizationId', foreign);
      assert.equal((await upload(extra)).status, 400);
      const duplicate = form(); duplicate.append('document', new Blob(['another'], { type: 'text/plain' }), 'another.txt');
      assert.equal((await upload(duplicate)).status, 400);
      const wrongField = new FormData(); wrongField.append('file', new Blob(['text'], { type: 'text/plain' }), 'wrong.txt');
      assert.equal((await upload(wrongField)).status, 400);
      const large = await upload(form(Buffer.alloc(MAX + 1, 0x61)));
      assert.equal(large.status, 413); assert.equal(large.body.code, 'UPLOAD_TOO_LARGE');
      assert.deepEqual(await files(), before); assert.equal(enqueued.length, 0);
    });
    await t.test('valid text upload saves one scoped record and only a small job payload', async () => {
      const result = await upload(form());
      assert.equal(result.status, 202);
      saved = await prisma.document.findUniqueOrThrow({ where: { id: result.body.data.id } });
      assert.equal(saved.organizationId, org); assert.equal(saved.uploadedById, user);
      assert.deepEqual(enqueued, [{ documentId: saved.id, organizationId: org }]);
      assert.equal(path.dirname(path.resolve(saved.storagePath)), root);
      assert.match(saved.name, /^[0-9a-f-]{36}\.txt$/);
      assert.equal(result.body.data.storagePath, undefined);
    });
    await t.test('exactly 10 MiB is accepted and queue uncertainty preserves recoverable file/record', async () => {
      const result = await upload(form(Buffer.alloc(MAX, 0x61), 'limit.txt'));
      assert.equal(result.status, 202);
      app.locals.getDocumentQueue = async () => { throw new Error('queue offline'); };
      const uncertain = await upload(form('recoverable text', 'recoverable.txt'));
      assert.equal(uncertain.status, 503); assert.equal(uncertain.body.code, 'DOCUMENT_QUEUE_UNAVAILABLE');
      const record = await prisma.document.findUniqueOrThrow({ where: { id: uncertain.body.data.id } });
      assert.equal(await fs.readFile(record.storagePath, 'utf8'), 'recoverable text');
    });
    await t.test('failed database persistence removes only its unaccepted file', async () => {
      const before = await files();
      prisma.$transaction = (work, options) => originalTransaction.call(prisma, tx => work({
        $queryRaw: tx.$queryRaw.bind(tx), organizationMember: tx.organizationMember,
        document: { create: async () => { throw new Error('private database error'); }, findFirst: tx.document.findFirst.bind(tx.document) },
      }), options);
      try { const result = await upload(form()); assert.equal(result.status, 500); assert.equal(JSON.stringify(result.body).includes('private'), false); }
      finally { prisma.$transaction = originalTransaction; }
      assert.deepEqual(await files(), before);
    });
    await t.test('lost commit acknowledgement retains the committed file and returns its recovery ID', async () => {
      let first = true;
      prisma.$transaction = async (work, options) => {
        if (!first) return originalTransaction.call(prisma, work, options);
        first = false;
        await originalTransaction.call(prisma, work, options);
        throw new Error('Controlled lost commit acknowledgement');
      };
      try {
        const result = await upload(form('committed content', 'committed.txt'));
        assert.equal(result.status, 503); assert.equal(result.body.code, 'DOCUMENT_QUEUE_UNAVAILABLE');
        const record = await prisma.document.findUniqueOrThrow({ where: { id: result.body.data.id } });
        assert.equal(await fs.readFile(record.storagePath, 'utf8'), 'committed content');
      } finally { prisma.$transaction = originalTransaction; }
    });
    await t.test('an unavailable reconciliation keeps the ambiguous file instead of claiming absence', async () => {
      const before = await files();
      prisma.$transaction = async () => { throw new Error('Controlled database outage'); };
      try {
        const result = await upload(form('unconfirmed content'));
        assert.equal(result.status, 503); assert.equal(result.body.code, 'UPLOAD_SAVE_UNCONFIRMED');
        assert.equal(result.body.data, undefined);
      } finally { prisma.$transaction = originalTransaction; }
      assert.equal((await files()).length, before.length + 1);
    });
    await t.test('removal during upload is rechecked at record admission and cleans that upload', async () => {
      const before = await files();
      let first = true;
      prisma.$transaction = (work, options) => originalTransaction.call(prisma, async tx => {
        if (first) { first = false; await prisma.organizationMember.delete({ where: { userId_organizationId: context } }); }
        return work(tx);
      }, options);
      try { const result = await upload(form()); assert.equal(result.status, 403); assert.equal(result.body.code, 'MEMBERSHIP_REQUIRED'); }
      finally { prisma.$transaction = originalTransaction; }
      assert.deepEqual(await files(), before);
    });
    await t.test('removed members cannot read status/search or create files; a foreign member sees a scoped 404', async () => {
      const before = await files();
      assert.equal((await call(`/documents/${saved.id}/status`)).status, 403);
      assert.equal((await call('/documents/search', json({ query: 'Question?' }))).status, 403);
      assert.equal((await upload(form())).status, 403); assert.deepEqual(await files(), before);
      const foreignRead = await call(`/documents/${saved.id}/status`, { headers: { Authorization: `Bearer ${foreignToken}` } });
      assert.equal(foreignRead.status, 404);
    });
    await t.test('unexpected uncaught errors use the shared safe JSON fallback', async () => {
      const failing = express(); installApiBoundary(failing, [origin]);
      failing.get('/error', () => { throw new Error('private SQL password'); }); failing.use(apiError);
      errorsServer = failing.listen(0, '127.0.0.1'); await once(errorsServer, 'listening');
      const result = await fetch(`http://127.0.0.1:${errorsServer.address().port}/error`);
      assert.equal(result.status, 500);
      assert.deepEqual(await result.json(), { success: false, code: 'INTERNAL_ERROR', message: 'The request could not be completed. Please try again later.' });
    });
  } finally {
    prisma.user.findUnique = originalUserRead; prisma.$transaction = originalTransaction;
    if (server) await new Promise(resolve => server.close(resolve));
    if (errorsServer) await new Promise(resolve => errorsServer.close(resolve));
    try {
      // Verify the absolute fixture folder and exact regular files before removal.
      assert.equal(path.dirname(root), path.resolve('uploads', 'documents'));
      for (const name of await files()) {
        assert.match(name, /^[0-9a-f-]{36}\.(txt|pdf|docx)$/);
        const target = path.join(root, name); assert.equal(path.dirname(target), root);
        const info = await fs.lstat(target); assert.equal(info.isFile() && !info.isSymbolicLink(), true);
        await fs.unlink(target);
      }
      await fs.rmdir(root).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await prisma.organization.deleteMany({ where: { id: { in: [org, foreign] } } });
      await prisma.user.deleteMany({ where: { id: { in: [user, outsider] } } });
    } finally {
      if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
      await prisma.$disconnect();
    }
  }
});
