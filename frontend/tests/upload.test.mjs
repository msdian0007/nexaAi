import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/services/api.ts';
import { validateFile, MAX_UPLOAD_BYTES } from '../src/features/documents/document.types.ts';

test('multipart preserves FormData and leaves Content-Type to the browser', async () => {
  const form = new FormData();
  form.append('document', new File(['Policy text'], 'policy.txt', { type: 'text/plain' }));
  const client = createApiClient('https://backend.example', async (_url, init) => {
    assert.equal(init.body, form);
    assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(await init.body.get('document').text(), 'Policy text');
    return Response.json({ success: true, data: { id: 'doc' } });
  });
  assert.deepEqual(await client('/documents/upload', { method: 'POST', body: form, token: 'test-token' }), { id: 'doc' });
});

test('file validation checks size, empty content, extension and optional MIME', () => {
  assert.equal(validateFile(new File(['Text'], 'Policy.TXT', { type: 'text/plain' })), null);
  assert.equal(validateFile(new File(['Text'], 'policy.txt')), null);
  assert.match(validateFile(new File([], 'policy.txt')), /empty/);
  assert.match(validateFile(new File(['x'], 'policy.exe')), /PDF/);
  assert.match(validateFile(new File(['x'], 'policy.txt', { type: 'image/png' })), /type/);
  assert.equal(validateFile(new File([new Uint8Array(MAX_UPLOAD_BYTES)], 'policy.txt')), null);
  assert.match(validateFile(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'policy.txt')), /10 MiB/);
});
