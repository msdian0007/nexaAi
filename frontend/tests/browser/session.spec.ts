import { test, expect } from '../support/browser';
import type { Page } from '@playwright/test';

const start = new Date('2026-10-26T12:00:00.000Z');
const expiresAt = new Date(start.getTime() + 120000).toISOString();
const user = { id: 'u', name: 'Asha', email: 'asha@example.invalid' };
const organization = { id: 'o', name: 'Support', slug: 'support' };
const session = { token: 'session-test-token', expiresAt, user, organization, role: 'OWNER' };
const me = { userId: user.id, organizationId: organization.id, role: 'OWNER', expiresAt };
async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  // Browser time is controlled; no real waiting or fabricated JWT verification.
  // Actual signature/expiry/revocation checks live in the backend integration suite.
  await page.clock.install({ time: start });
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: session } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: me } }));
});

test('server-verified deadline expires an idle page without another API request', async ({ page }) => {
  const earlier = new Date(start.getTime() + 60000).toISOString();
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { ...me, expiresAt: earlier } } }));
  await login(page);
  await expect(page.getByRole('heading', { name: 'Welcome, Asha' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  let requests = 0;
  page.on('request', r => { if (r.url().includes('/api/v1/')) requests++; });
  await page.clock.fastForward(60001);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('session has expired');
  expect(requests).toBe(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('sign-out hides private content immediately while server acknowledgement is pending', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/auth/logout', async route => {
    expect(route.request().headers().authorization).toBe('Bearer session-test-token');
    expect(route.request().postData()).toBeNull();
    await gate; await route.fulfill({ json: { success: true, data: { signedOut: true } } });
  });
  const sent = page.waitForRequest('**/api/v1/auth/logout');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await sent;
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.locator('.dashboard-cards')).toHaveCount(0);
  release();
});

test('offline server sign-out is reported honestly after local session clearance', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  await page.route('**/api/v1/auth/logout', route => route.fulfill({ status: 503, json: { success: false, message: 'private database exception' } }));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('alert')).toContainText('Signed out on this browser. Server sign-out could not be confirmed.');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByText('private database exception')).toHaveCount(0);
});

test('a late failed sign-out cannot replace a newer verified session', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/auth/logout', async route => {
    await gate; await route.fulfill({ status: 503, json: { success: false } });
  });
  const sent = page.waitForRequest('**/api/v1/auth/logout');
  await page.getByRole('button', { name: 'Sign out' }).click(); await sent;
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'Welcome, Asha' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('removed membership during verification hides private routes but permits a fresh organization session', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 403, json: { success: false, code: 'ORGANIZATION_ACCESS_REVOKED' } }));
  await login(page);
  await expect(page.getByRole('heading', { name: 'Organization access changed' })).toBeVisible();
  await expect(page.locator('.dashboard-cards')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Chat', exact: true })).toHaveCount(0);
  const sales = { id: 'sales', name: 'Sales', slug: 'sales' };
  await page.route('**/api/v1/auth/organizations', route => route.fulfill({ json: { success: true, data: [{ organization: sales, role: 'MEMBER' }] } }));
  await page.route('**/api/v1/auth/switch-organization', route => {
    expect(route.request().headers().authorization).toBe('Bearer session-test-token');
    return route.fulfill({ json: { success: true, data: { ...session, token: 'sales-token', organization: sales, role: 'MEMBER' } } });
  });
  await page.route('**/api/v1/auth/me', route => route.fulfill(route.request().headers().authorization === 'Bearer sales-token'
    ? { json: { success: true, data: { ...me, organizationId: sales.id, role: 'MEMBER' } } }
    : { status: 403, json: { success: false, code: 'ORGANIZATION_ACCESS_REVOKED' } }));
  await page.getByRole('link', { name: 'Switch organization', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Sales', exact: true }).click();
  await expect(page.getByText('You are signed in to Sales.')).toBeVisible();
});

test('an explicit membership rejection removes the entire private view without treating every 403 as logout', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  await page.route('**/api/v1/analytics/summary?*', route => route.fulfill({ status: 403, json: { success: false, code: 'DASHBOARD_MEMBERSHIP_REQUIRED' } }));
  await page.getByRole('button', { name: 'Refresh summary' }).click();
  await expect(page.getByRole('heading', { name: 'Organization access changed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Documents', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('verification outage preserves recovery while hiding protected content', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 503, json: { success: false, code: 'SESSION_UNAVAILABLE' } }));
  await login(page);
  await expect(page.getByRole('heading', { name: 'Unable to verify your session' })).toBeVisible();
  await expect(page.locator('.dashboard-cards')).toHaveCount(0);
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: me } }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Asha' })).toBeVisible();
});
