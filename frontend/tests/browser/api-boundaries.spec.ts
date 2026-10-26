import { test, expect } from '../support/dashboard-live';

// Uses the production createApiApp factory: actual headers, CORS, JSON limits,
// JWTs and PostgreSQL. The temporary fixture creates no real queue jobs.
test.use({ fullApi: true });
test.setTimeout(90000);

test('password byte limits reject locally, then an ordinary login reaches the protected production API', async ({ page, fixture: f }) => {
  let logins = 0;
  page.on('request', request => { if (request.url().endsWith('/auth/login')) logins++; });
  await page.goto('/login');
  await page.getByLabel('Email address').fill(f.email);
  for (const password of ['x'.repeat(73), '😀'.repeat(20)]) {
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('72 UTF-8 bytes');
  }
  expect(logins).toBe(0);
  await page.getByLabel('Password', { exact: true }).fill(f.password);
  const response = page.waitForResponse(r => r.url().endsWith('/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  expect(result.headers()['cache-control']).toBe('no-store');
  expect(result.headers()['x-content-type-options']).toBe('nosniff');
  expect(result.headers()['access-control-allow-origin']).toBe('http://127.0.0.1:4173');
  await expect(page.locator('.dashboard-number')).toHaveText(['4', '3', '5']);
  expect(logins).toBe(1);
});

test('a renamed PDF reaches server content validation and displays a safe actionable error', async ({ page, fixture: f }) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(f.email);
  await page.getByLabel('Password', { exact: true }).fill(f.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await page.getByLabel('Select a document').setInputFiles({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('ordinary text, not a PDF header') });
  const response = page.waitForResponse(r => r.url().endsWith('/documents/upload'));
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(415);
  expect((await result.json()).code).toBe('INVALID_FILE_CONTENT');
  await expect(page.getByRole('alert')).toContainText('file content does not match its format');
  await expect(page.getByRole('region', { name: 'Latest upload', exact: true })).toHaveCount(0);
});
