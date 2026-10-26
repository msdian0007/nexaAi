const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startAgentFixture } = require('./helpers/agent.http-fixture.cjs');

test('agent HTTP routes enforce identity, data isolation, confirmation and metadata records', { timeout: 90000 }, async t => {
  const f = await startAgentFixture();
  const call = async (path, options = {}, token = f.token()) => {
    const response = await fetch(`${f.baseUrl}/agents${path}`, { method: options.method ?? 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const ask = message => call('/requests', { method: 'POST', body: { message } });
  const doc = f.documents[1];
  const job = () => f.inspector.getJob(`document-${f.context.organizationId}-${doc.id}`);
  const propose = async () => {
    const response = await ask(`Retry document ${doc.id}`);
    assert.equal(response.status, 200);
    return response.body.data.result.proposal;
  };
  try {
    await t.test('actual password login issues credentials accepted by agent routes', async () => {
      const response = await fetch(`${f.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: f.email, password: f.password }) });
      const login = await response.json(); assert.equal(response.status, 200);
      assert.equal((await call('/executions', {}, login.data.token)).status, 200);
    });
    await t.test('missing identity, malformed bodies, IDs, query and context overrides fail before selection', async () => {
      const before = f.calls.selection;
      assert.equal((await call('/requests', { method: 'POST', body: { message: 'Count documents' } }, null)).status, 401);
      for (const body of [{ message: 'Count documents', organizationId: f.foreign }, { message: 'Question', tool: 'retry_document' }, {}, [], null]) {
        assert.equal((await call('/requests', { method: 'POST', body })).status, 400);
      }
      assert.equal((await call('/requests?role=OWNER', { method: 'POST', body: { message: 'Count documents' } })).status, 400);
      assert.equal((await call('/proposals/bad/confirm', { method: 'POST' })).status, 400);
      assert.equal((await call('/executions?limit=999')).status, 400);
      const oversized = await fetch(`${f.baseUrl}/agents/requests`, { method: 'POST',
        headers: { Authorization: `Bearer ${f.token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(110000) }) });
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json()).code, 'INVALID_AGENT_REQUEST');
      assert.equal(f.calls.selection, before);
    });
    await t.test('count and cited knowledge results retain their types and no-store headers', async () => {
      const counts = await ask('How many documents have saved FAILED status?');
      assert.equal(counts.status, 200); assert.equal(counts.cache, 'no-store');
      assert.equal(counts.body.data.result.result.tool, 'document_counts');
      assert.equal(counts.body.data.result.result.data.total, 2);
      const answer = await ask('What is our leave policy?');
      assert.equal(answer.status, 200);
      assert.equal(answer.body.data.result.result.data.sources[0].documentId, f.documents[0].id);
      const record = await f.prisma.agentExecution.findUniqueOrThrow({ where: { id: answer.body.data.executionId } });
      assert.equal(record.tool, 'knowledge_answer'); assert.equal(record.outcome, 'SUCCEEDED'); assert.ok(record.durationMs >= 0);
      assert.equal(JSON.stringify(record).includes('leave policy'), false);
      assert.equal(JSON.stringify(record).includes('18 days'), false);
    });
    await t.test('clarification and unsupported results succeed without submitting jobs', async () => {
      assert.equal((await ask('Count failed documents last month')).body.data.result.kind, 'clarification');
      assert.equal((await ask('Send email')).body.data.result.kind, 'unsupported');
      assert.equal(await f.inspector.getWaitingCount(), 0);
    });
    await t.test('proposal creation submits nothing; cancellation and confirmation are separate authenticated endpoints', async () => {
      const p = await propose(); assert.equal(await f.inspector.getWaitingCount(), 0);
      assert.equal((await call(`/proposals/${p.id}`)).body.data.state, 'PENDING');
      assert.equal((await call(`/proposals/${p.id}/cancel`, { method: 'POST' })).body.data.result.state, 'CANCELLED');
      assert.equal((await call(`/proposals/${p.id}/confirm`, { method: 'POST' })).status, 409);
      const next = await propose();
      const accepted = await call(`/proposals/${next.id}/confirm`, { method: 'POST' });
      assert.equal(accepted.status, 202); assert.equal(accepted.body.data.result.data.state, 'accepted');
      assert.equal((await call(`/proposals/${next.id}/document-status`)).body.data.processingState, 'QUEUED');
      assert.equal((await call(`/proposals/${next.id}/confirm`, { method: 'POST' })).status, 409);
      assert.equal(await f.inspector.getWaitingCount(), 1);
      await (await job()).remove();
    });
    await t.test('peers and other organizations cannot read or confirm a private proposal or inspect its status', async () => {
      const p = await propose();
      for (const token of [f.token(f.peer), f.token(f.outsider, f.foreign)]) {
        assert.equal((await call(`/proposals/${p.id}`, {}, token)).status, 404);
        assert.equal((await call(`/proposals/${p.id}/document-status`, {}, token)).status, 404);
        assert.equal((await call(`/proposals/${p.id}/confirm`, { method: 'POST' }, token)).status, 404);
      }
      assert.equal((await call(`/proposals/${p.id}/confirm`, { method: 'POST', body: { confirmed: true } })).status, 400);
      assert.equal(await f.inspector.getWaitingCount(), 0);
    });
    await t.test('expired and changed proposals fail with controlled codes without queue writes', async () => {
      const p = await propose();
      await f.prisma.agentRetryProposal.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await call(`/proposals/${p.id}/confirm`, { method: 'POST' })).body.code, 'PROPOSAL_EXPIRED');
      const next = await propose();
      await f.prisma.document.update({ where: { id: doc.id }, data: { originalName: 'changed.txt' } });
      assert.equal((await call(`/proposals/${next.id}/confirm`, { method: 'POST' })).body.code, 'DOCUMENT_CHANGED');
      assert.equal(await f.inspector.getWaitingCount(), 0);
      await f.prisma.document.update({ where: { id: doc.id }, data: { originalName: 'retry-me.txt' } });
    });
    await t.test('provider and malformed-routing errors return safe errors and FAILED execution metadata', async () => {
      f.controls.route = () => { throw new Error('private provider secret and prompt'); };
      try {
        const result = await ask('Secret request should never appear in metadata');
        assert.equal(result.status, 503); assert.equal(JSON.stringify(result.body).includes('private'), false);
        const record = await f.prisma.agentExecution.findUniqueOrThrow({ where: { id: result.body.executionId } });
        assert.equal(record.outcome, 'FAILED'); assert.equal(record.errorCode, 'AGENT_UNAVAILABLE');
        assert.equal(JSON.stringify(record).includes('Secret request'), false);
      } finally { f.controls.route = undefined; }
      f.controls.route = () => '{}';
      try { assert.equal((await ask('Question')).body.code, 'INVALID_AGENT_RESPONSE'); }
      finally { f.controls.route = undefined; }
    });
    await t.test('an unavailable execution store blocks model/tool work before side effects', async () => {
      const original = f.prisma.agentExecution.create;
      const before = f.calls.selection;
      f.prisma.agentExecution.create = async () => { throw new Error('Store unavailable'); };
      try { assert.equal((await ask(`Retry ${doc.id}`)).status, 503); }
      finally { f.prisma.agentExecution.create = original; }
      assert.equal(f.calls.selection, before); assert.equal(await f.inspector.getWaitingCount(), 0);
    });
    await t.test('a receipt-log failure after accepted submission returns uncertainty; proposal remains consumed', async () => {
      const p = await propose();
      const original = f.prisma.agentExecution.update;
      f.prisma.agentExecution.update = args => args.data.outcome === 'SUCCEEDED' ? Promise.reject(new Error('Lost final record')) : original.call(f.prisma.agentExecution, args);
      let response;
      try { response = await call(`/proposals/${p.id}/confirm`, { method: 'POST' }); }
      finally { f.prisma.agentExecution.update = original; }
      assert.equal(response.status, 503);
      assert.equal((await f.prisma.agentExecution.findUniqueOrThrow({ where: { id: response.body.executionId } })).outcome, 'UNCONFIRMED');
      assert.equal((await call(`/proposals/${p.id}`)).body.data.state, 'ACCEPTED');
      assert.equal((await call(`/proposals/${p.id}/confirm`, { method: 'POST' })).status, 409);
      assert.equal(await f.inspector.getWaitingCount(), 1); await (await job()).remove();
    });
    await t.test('records list is private, bounded to 20 and has only approved metadata fields', async () => {
      for (let i = 0; i < 22; i++) await ask('How many documents are saved?');
      const records = (await call('/executions')).body.data.executions;
      assert.equal(records.length, 20);
      for (const r of records) assert.deepEqual(Object.keys(r).sort(), ['durationMs', 'errorCode', 'finishedAt', 'id', 'operation', 'outcome', 'proposalId', 'startedAt', 'tool']);
      const other = await call('/executions', {}, f.token(f.outsider, f.foreign));
      assert.equal(other.body.data.executions.some(r => records.some(own => own.id === r.id)), false);
      const peer = await call('/executions', {}, f.token(f.peer));
      assert.equal(peer.body.data.executions.some(r => records.some(own => own.id === r.id)), false);
    });
    await t.test('removed membership denies request, records and proposal reads without provider work', async () => {
      const p = await propose(); const before = f.calls.selection;
      await f.prisma.organizationMember.delete({ where: { userId_organizationId: f.context } });
      try {
        assert.equal((await ask('Count documents')).status, 403);
        assert.equal((await call('/executions')).status, 403);
        assert.equal((await call(`/proposals/${p.id}`)).status, 403);
        assert.equal((await call(`/proposals/${p.id}/confirm`, { method: 'POST' })).status, 403);
        assert.equal(f.calls.selection, before);
      } finally { await f.prisma.organizationMember.create({ data: { ...f.context, role: 'MEMBER' } }); }
      assert.equal(await f.prisma.agentExecution.count({ where: f.context }), 0);
    });
    await t.test('unknown proposal IDs give a controlled unavailable response', async () => {
      assert.equal((await call(`/proposals/${randomUUID()}`)).status, 404);
    });
  } finally { await f.stop(); }
});
