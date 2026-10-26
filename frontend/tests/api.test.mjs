import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError } from '../src/services/api.ts';

test('rate limits display bounded wait times without retrying or revealing server messages', async () => {
  for (const [value, expected] of [['12', '12 seconds'], ['86400', '86400 seconds'], ['0', 'later'], ['999999999', 'later'], ['<script>PRIVATE</script>', 'later'], ['1.5', 'later']]) {
    let calls = 0;
    const client = createApiClient('https://backend.example', async () => {
      calls++; return Response.json({ success: false, code: 'RATE_LIMITED', message: 'PRIVATE' }, { status: 429, headers: { 'Retry-After': value } });
    });
    await assert.rejects(client('/chat/query', { method: 'POST', body: { question: 'policy' } }), error => error.status === 429 && error.message.includes(expected) && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
  const fallback = createApiClient('https://backend.example', async () => Response.json({ code: 'RATE_LIMITED', retryAfterSeconds: 35 }, { status: 429 }));
  await assert.rejects(fallback('/chat/query'), error => error.message.includes('35 seconds'));
});

test('sends credentials as JSON, unwraps data, and keeps the token explicit', async () => {
  const client = createApiClient('https://backend.example/api/v1/', async (url, init) => {
    assert.equal(url, 'https://backend.example/api/v1/auth/login');
    assert.deepEqual(JSON.parse(init.body), { email: 'demo@example.invalid', password: 'fictional' });
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return Response.json({ success: true, data: { token: 'test-token' } });
  });
  assert.deepEqual(await client('/auth/login', { method: 'POST', body: { email: 'demo@example.invalid', password: 'fictional' } }), { token: 'test-token' });
});

test('protected calls include Bearer authentication without a JSON body', async () => {
  const client = createApiClient('https://backend.example', async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.body, undefined);
    return Response.json({ success: true, data: { userId: 'user' } });
  });
  assert.deepEqual(await client('/auth/me', { token: 'test-token' }), { userId: 'user' });
});

test('rejects external and traversal paths before transmitting tokens', async () => {
  const client = createApiClient('https://backend.example', async () => assert.fail('No request expected'));
  for (const path of ['https://other.example', '//other.example', '/../other', '/%2e%2e/other', '/auth/me?redirect=other']) {
    await assert.rejects(client(path, { token: 'test-token' }), error => error.code === 'INVALID_PATH');
  }
});

test('preserves error status and code but does not expose backend error details', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const client = createApiClient('https://backend.example', async () => Response.json({ message: 'PRIVATE_DATABASE_DETAILS', code: 'EXAMPLE' }, { status }));
    await assert.rejects(client('/auth/me'), error => error instanceof ApiError && error.status === status && error.code === 'EXAMPLE' && !error.message.includes('PRIVATE'));
  }
});

test('handles HTML errors, malformed success envelopes and network failures', async () => {
  for (const payload of [null, {}, { success: false }, { success: true }]) {
    const client = createApiClient('https://backend.example', async () => Response.json(payload));
    await assert.rejects(client('/auth/me'), error => error.code === 'INVALID_RESPONSE');
  }
  const html = createApiClient('https://backend.example', async () => new Response('<html>error</html>', { status: 502 }));
  await assert.rejects(html('/auth/me'), error => error.status === 502);
  const offline = createApiClient('https://backend.example', async () => { throw new Error('PRIVATE'); });
  await assert.rejects(offline('/auth/me'), error => error.code === 'NETWORK' && !error.message.includes('PRIVATE'));
});

test('preserves caller cancellation so unmounted views can ignore it', async () => {
  const controller = new AbortController();
  const client = createApiClient('https://backend.example', async (_url, init) => {
    controller.abort();
    init.signal.throwIfAborted();
  });
  await assert.rejects(client('/auth/me', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('upload/origin errors use known local messages and unknown codes never read object prototypes', async () => {
  for (const [status, code, phrase] of [[413, 'UPLOAD_TOO_LARGE', '10 MiB'], [415, 'INVALID_FILE_CONTENT', 'file content'],
    [400, 'EMPTY_UPLOAD', 'empty'], [403, 'ORIGIN_NOT_ALLOWED', 'frontend address'], [400, '__proto__', 'check your details']]) {
    const client = createApiClient('https://backend.example', async () => Response.json({ success: false, code, message: 'PRIVATE SQL' }, { status }));
    await assert.rejects(client('/documents/upload'), error => typeof error.message === 'string' && error.message.includes(phrase) && !error.message.includes('PRIVATE'));
  }
});
