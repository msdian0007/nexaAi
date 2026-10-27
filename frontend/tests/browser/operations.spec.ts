import { test, expect } from '../support/browser';
import { randomUUID } from 'node:crypto';
const id = randomUUID();
const summary = { organizationId: 'o', observedAt: new Date().toISOString(), totalDocuments: 1, failedDocuments: 1,
  queueAvailable: true, workersAvailable: false, sampleSize: 1, sampleTruncated: false,
  states: { waiting: 0, active: 0, delayed: 0, failed: 1, completed: 0, unknown: 0, unavailable: 0 }, alerts: ['NO_DOCUMENT_WORKER'] };
const event = () => ({ id: randomUUID(), actorId: id, targetId: id, requestId: id, createdAt: new Date().toISOString(), action: 'MEMBER_ROLE_CHANGED' });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: { token: 'test-token', user: { id: 'u', name: 'Asha', email: 'asha@example.invalid' }, organization: { id: 'o', name: 'Sample Team', slug: 'sample-team' }, role: 'OWNER' } } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'o', role: 'OWNER' } } }));
  await page.route('**/api/v1/operations/summary', route => route.fulfill({ json: { success: true, data: summary } }));
  await page.route('**/api/v1/operations/audit*', route => route.fulfill({ json: { success: true, data: { organizationId: 'o', events: [], nextCursor: null } } }));
  await page.goto('/login'); await page.getByLabel('Email address').fill('asha@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
});

test('bounded audit pages append through explicit reads; refresh replaces stale events', async ({ page }) => {
  const first = event(), second = event();
  let loadedOlder = false;
  await page.route('**/api/v1/operations/audit*', route => {
    // Read responses depend on the cursor, not request count: StrictMode or a
    // cancelled read can legitimately request the first page more than once.
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor) { expect(cursor).toBe(id); loadedOlder = true; }
    return route.fulfill({ json: { success: true, data: { organizationId: 'o',
      events: cursor ? [second] : loadedOlder ? [] : [first], nextCursor: !cursor && !loadedOlder ? id : null } } });
  });
  await page.getByRole('link', { name: 'Operations', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Member role changed', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Load more audit events' }).click();
  await expect(page.getByRole('cell', { name: 'Member role changed', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Refresh operations' }).click();
  await expect(page.getByText('No recorded actions.', { exact: true })).toBeVisible();
});

test('foreign/invalid summaries and arbitrary fields cannot render private or fabricated metrics', async ({ page }) => {
  await page.route('**/api/v1/operations/summary', route => route.fulfill({ json: { success: true, data: { ...summary, organizationId: 'foreign', alerts: ['PRIVATE_DATABASE_DETAIL'] } } }));
  await page.getByRole('link', { name: 'Operations', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await expect(page.getByRole('heading', { name: 'Document processing' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('PRIVATE_DATABASE_DETAIL');
});

test('navigation ignores a late operations response', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/operations/summary', async route => { await gate; await route.fulfill({ json: { success: true, data: summary } }); });
  await page.getByRole('link', { name: 'Operations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Operations and audit history' })).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click(); release();
  await expect(page.getByRole('heading', { name: 'Welcome, Asha' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Document processing' })).toHaveCount(0);
});
