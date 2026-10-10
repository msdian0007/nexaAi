import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/services/api.ts';

test('encodes pagination parameters without weakening API path validation', async () => {
  const client = createApiClient('https://backend.example/api/v1', async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/v1/chat/conversations');
    assert.equal(new URL(url).searchParams.get('cursor'), 'a&b=/#?');
    assert.equal(new URL(url).searchParams.get('limit'), '20');
    assert.equal(init.headers.Authorization, 'Bearer example');
    return Response.json({ success: true, data: [] });
  });
  await client('/chat/conversations', { token: 'example', query: { limit: 20, cursor: 'a&b=/#?' } });
  await assert.rejects(client('//other.example', { query: { limit: 20 } }), error => error.code === 'INVALID_PATH');
});
