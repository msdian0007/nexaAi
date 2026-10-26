import { test, expect } from "../support/browser";

const document = { id: 'doc-1', originalName: 'policy.txt', status: 'COMPLETED', updatedAt: '2026-10-05T09:00:00Z', errorMessage: null };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/documents?*', route => route.fulfill({ json: { success: true, data: {
    organizationId: 'o', documents: [], page: { limit: 10, hasMore: false, nextCursor: null },
  } } }));
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: {
    token: 'test-token', user: { id: 'u', name: 'Asha', email: 'asha@example.invalid' },
    organization: { id: 'o', name: 'Sample Team', slug: 'sample-team' }, role: 'OWNER',
  } } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'o', role: 'OWNER' } } }));
  await page.goto('/login');
  await page.getByLabel('Email address').fill('asha@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
});

test('uploads the actual selected bytes with authentication and refreshes status', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/documents/upload', async route => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    expect(route.request().headers()['content-type']).toContain('multipart/form-data; boundary=');
    expect(route.request().postDataBuffer()?.toString()).toContain('name="document"; filename="policy.txt"');
    expect(route.request().postDataBuffer()?.toString()).toContain('18 days of leave');
    await gate;
    await route.fulfill({ status: 202, json: { success: true, data: document, document } });
  });
  await page.route('**/api/v1/documents/doc-1/status', route => route.fulfill({ json: { success: true, data: { ...document, status: 'FAILED' } } }));
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('18 days of leave') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Uploading...' })).toBeDisabled();
  release();
  await expect(page.getByRole('status')).toContainText('Ready for questions');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('status')).toContainText('Processing failed');
});

test('rejects empty, unsupported and oversized files before making upload requests', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/documents/upload', route => { calls++; return route.abort(); });
  for (const file of [
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: 'script.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('bad') },
    { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
  ]) {
    await page.getByLabel('Select a document').setInputFiles(file);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload document', exact: true })).toBeDisabled();
  }
  expect(calls).toBe(0);
});

test('upload failures do not claim success or automatically retry; expired auth returns to login', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/documents/upload', route => {
    calls++;
    return route.fulfill({ status: calls === 1 ? 500 : 401, json: { message: 'private error' } });
  });
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not confirm');
  expect(calls).toBe(1);
  await expect(page.getByText('Ready for questions', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('alert')).toContainText('expired');
});

test('leaving the page during upload does not render a late success', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/documents/upload', async route => {
    await gate;
    await route.fulfill({ status: 202, json: { success: true, data: document } }).catch(() => {});
  });
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Uploading...' })).toBeDisabled();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  release();
  await expect(page.getByRole('heading', { name: 'Welcome, Asha' })).toBeVisible();
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Latest upload' })).toHaveCount(0);
});

test('polls queued work through automatic retry to Ready, then stops polling', async ({ page }) => {
  let checks = 0;
  await page.route('**/api/v1/documents/upload', route => route.fulfill({
    status: 202, json: { success: true, data: { ...document, status: 'UPLOADED', processingState: 'QUEUED', canRetry: false } },
  }));
  await page.route('**/api/v1/documents/doc-1/status', route => {
    checks++;
    return route.fulfill({ json: { success: true, data: {
      ...document, status: checks === 1 ? 'FAILED' : 'COMPLETED',
      processingState: checks === 1 ? 'RETRYING' : 'READY', canRetry: false,
    } } });
  });
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for processing');
  await expect(page.getByRole('status')).toContainText('Retrying automatically', { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Retry processing', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Ready for questions', { timeout: 10000 });
  await page.waitForTimeout(2500);
  expect(checks).toBe(2);
});

test('retains a saved file after queue failure and starts it without uploading again', async ({ page }) => {
  let uploads = 0;
  let retries = 0;
  await page.route('**/api/v1/documents/upload', route => {
    uploads++;
    return route.fulfill({ status: 503, json: { success: false, code: 'DOCUMENT_QUEUE_UNAVAILABLE',
      message: 'PRIVATE DETAILS', data: { ...document, status: 'UPLOADED', processingState: 'UNAVAILABLE', canRetry: false },
    } });
  });
  await page.route('**/api/v1/documents/doc-1/status', route => route.fulfill({ json: { success: true,
    data: { ...document, status: 'UPLOADED', processingState: retries ? 'READY' : 'NOT_QUEUED', canRetry: !retries },
  } }));
  await page.route('**/api/v1/documents/doc-1/reprocess', route => {
    retries++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    return route.fulfill({ status: 202, json: { success: true,
      data: { ...document, status: 'UPLOADED', processingState: 'QUEUED', canRetry: false },
    } });
  });
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your file is saved');
  await expect(page.getByText('PRIVATE DETAILS')).toHaveCount(0);
  await expect(page.getByText('policy.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.getByRole('button', { name: 'Start processing' }).click();
  await expect(page.getByRole('status')).toContainText('Ready for questions', { timeout: 10000 });
  expect(uploads).toBe(1);
  expect(retries).toBe(1);
});

test('a failed document can be retried and status polling resumes', async ({ page }) => {
  await page.route('**/api/v1/documents/upload', route => route.fulfill({ status: 202, json: { success: true,
    data: { ...document, status: 'FAILED', processingState: 'FAILED', canRetry: true },
  } }));
  await page.route('**/api/v1/documents/doc-1/reprocess', route => route.fulfill({ status: 202, json: { success: true,
    data: { ...document, status: 'FAILED', processingState: 'QUEUED', canRetry: false },
  } }));
  await page.route('**/api/v1/documents/doc-1/status', route => route.fulfill({ json: { success: true,
    data: { ...document, processingState: 'READY', canRetry: false },
  } }));
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await page.getByRole('button', { name: 'Retry processing', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for processing');
  await expect(page.getByRole('status')).toContainText('Ready for questions', { timeout: 10000 });
});

test('a polling error pauses checks and manual refresh resumes them', async ({ page }) => {
  let checks = 0;
  await page.route('**/api/v1/documents/upload', route => route.fulfill({ status: 202, json: { success: true,
    data: { ...document, status: 'UPLOADED', processingState: 'QUEUED', canRetry: false },
  } }));
  await page.route('**/api/v1/documents/doc-1/status', route => {
    checks++;
    if (checks === 1) return route.fulfill({ status: 503, json: { message: 'Private failure' } });
    return route.fulfill({ json: { success: true, data: { ...document, processingState: 'READY', canRetry: false } } });
  });
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Automatic status checks paused', { timeout: 10000 });
  await page.waitForTimeout(2500);
  expect(checks).toBe(1);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('status')).toContainText('Ready for questions');
});

test('navigation cancels an in-flight status poll and ignores its late result', async ({ page }) => {
  let checks = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/documents/upload', route => route.fulfill({ status: 202, json: { success: true,
    data: { ...document, status: 'UPLOADED', processingState: 'QUEUED', canRetry: false },
  } }));
  await page.route('**/api/v1/documents/doc-1/status', async route => {
    checks++;
    await gate;
    await route.fulfill({ json: { success: true, data: document } }).catch(() => {});
  });
  await page.getByLabel('Select a document').setInputFiles({ name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy') });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect.poll(() => checks, { timeout: 10000 }).toBe(1);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  release();
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Latest upload' })).toHaveCount(0);
  await page.waitForTimeout(2500);
  expect(checks).toBe(1);
});
