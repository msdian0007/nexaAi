import { test, expect } from '../support/dashboard-live';
import type { DashboardFixture } from '../support/dashboard-live';
import type { Page } from '@playwright/test';

test.use({ timezoneId: 'Asia/Kolkata' });
test.setTimeout(90000);

async function login(page: Page, f: DashboardFixture, peer = false) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(peer ? f.peerEmail : f.email);
  await page.getByLabel('Password', { exact: true }).fill(f.password);
  const response = page.waitForResponse(r => r.url().endsWith('/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = (await (await response).json()).data;
  expect(session.organization.id).toBe(f.organizationId);
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  return session.token as string;
}
async function dates(page: Page, from: string, through: string) {
  await page.getByLabel('From (UTC)', { exact: true }).fill(from);
  await page.getByLabel('Through (UTC, included)', { exact: true }).fill(through);
  const response = page.waitForResponse(r => r.url().includes('/analytics/summary?') && r.status() === 200);
  await page.getByRole('button', { name: 'Apply dates' }).click();
  const result = await response;
  expect(result.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
  return (await result.json()).data;
}
async function numbers(page: Page, expected: string[]) {
  await expect(page.locator('.dashboard-number')).toHaveText(expected);
}
async function switchTo(page: Page, name: string) {
  await page.getByRole('link', { name: 'Switch organization', exact: true }).click();
  await page.getByRole('button', { name: `Switch to ${name}`, exact: true }).click();
  await expect(page.getByText(`You are signed in to ${name}.`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh summary' })).toBeVisible();
}

test('real dashboard matches retained fixtures, UTC dates, refreshed writes and deletion', async ({ page, fixture: f }) => {
  await test.step('default seven days include older personal activity but all current document statuses', async () => {
    await login(page, f);
    await numbers(page, ['4', '3', '5']);
    const docs = page.getByRole('region', { name: 'Current documents', exact: true });
    for (const label of ['Uploaded', 'Processing', 'Completed', 'Failed']) {
      await expect(docs.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('1');
    }
  });
  await test.step('three-day API and rendered daily table match hand-calculated counts', async () => {
    const data = await dates(page, f.from, f.through);
    expect(data.range).toEqual({ from: f.from, to: f.to, days: 3, timezone: 'UTC' });
    expect(data.personalActivity.agentRequests.byOutcome).toEqual({ STARTED: 1, SUCCEEDED: 1, FAILED: 1, UNCONFIRMED: 1 });
    expect(data.daily).toEqual([
      { date: f.from, organizationUploads: 1, ownSavedChatQuestions: 0, ownAgentRequests: 0 },
      { date: f.yesterday, organizationUploads: 1, ownSavedChatQuestions: 1, ownAgentRequests: 1 },
      { date: f.through, organizationUploads: 1, ownSavedChatQuestions: 1, ownAgentRequests: 3 },
    ]);
    const encoded = JSON.stringify(data);
    for (const hidden of [f.userId, f.peerId, f.organizationId, f.foreignId, f.secretId, 'fixture private', 'storagePath', 'content', 'password']) expect(encoded.includes(hidden)).toBe(false);
    await numbers(page, ['4', '2', '4']);
    await page.getByText('View daily values', { exact: true }).click();
    const rows = page.getByRole('table').locator('tbody tr');
    await expect(rows).toHaveCount(3);
    expect(await rows.nth(0).locator('th, td').allTextContents()).toEqual([f.from, '1', '0', '0']);
    expect(await rows.nth(1).locator('th, td').allTextContents()).toEqual([f.yesterday, '1', '1', '1']);
    expect(await rows.nth(2).locator('th, td').allTextContents()).toEqual([f.through, '1', '1', '3']);
    await expect(page.getByRole('img', { name: 'Daily retained activity in UTC' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('dashboard-real-summary.png'), fullPage: true });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('dashboard-real-mobile.png'), fullPage: true });
  });
  await test.step('single-day and empty activity ranges leave current documents intact', async () => {
    await dates(page, f.yesterday, f.yesterday);
    await numbers(page, ['4', '1', '1']);
    await dates(page, f.emptyFrom, f.emptyThrough);
    await numbers(page, ['4', '0', '0']);
    await expect(page.getByText('No retained activity in this date range.')).toBeVisible();
    await dates(page, f.from, f.through);
  });
  await test.step('new committed records appear on refresh without creating model requests', async () => {
    await f.control('add-activity');
    await page.getByRole('button', { name: 'Refresh summary' }).click();
    await numbers(page, ['5', '3', '5']);
  });
  await test.step('deleting retained records lowers prior counts without erasing agent metadata', async () => {
    await f.control('delete-retained');
    await page.getByRole('button', { name: 'Refresh summary' }).click();
    await numbers(page, ['4', '0', '5']);
    const docs = page.getByRole('region', { name: 'Current documents', exact: true });
    await expect(docs.locator('dl > div').filter({ has: page.getByText('Failed', { exact: true }) }).locator('dd')).toHaveText('0');
  });
});

test('real logins keep teammate activity private and switching replaces organization counts', async ({ page, fixture: f }) => {
  await login(page, f);
  await dates(page, f.from, f.through);
  await numbers(page, ['4', '2', '4']);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await login(page, f, true);
  await dates(page, f.from, f.through);
  await numbers(page, ['4', '3', '7']);
  const requests = page.getByRole('region', { name: 'My agent requests', exact: true });
  await expect(requests.locator('dl > div').filter({ has: page.getByText('Failed', { exact: true }) }).locator('dd')).toHaveText('7');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await login(page, f);
  await switchTo(page, 'Dashboard Sales');
  await numbers(page, ['2', '1', '2']);
  await expect(page.getByRole('table')).not.toBeVisible();
  await switchTo(page, 'Dashboard Support');
  await numbers(page, ['4', '3', '5']);
});

test('actual membership checks reject overrides, stale roles and revoked access with recovery', async ({ page, fixture: f }) => {
  const token = await login(page, f);
  const headers = { Authorization: `Bearer ${token}` };
  for (const override of [`organizationId=${f.secretId}`, `userId=${f.peerId}`]) {
    const response = await page.request.get(`${f.baseUrl}/analytics/summary?${override}`, { headers });
    expect(response.status()).toBe(400);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect((await response.json()).data).toBeUndefined();
  }
  await dates(page, f.from, f.through);
  // Keep the original OWNER token while changing actual membership. A role claim
  // does not authorize peer usage, and removal must block a still-signed token.
  for (const role of ['member', 'admin'] as const) {
    await f.control(role);
    await page.getByRole('button', { name: 'Refresh summary' }).click();
    await numbers(page, ['4', '2', '4']);
  }
  await f.control('revoke');
  await page.getByRole('button', { name: 'Refresh summary' }).click();
  await expect(page.getByRole('alert')).toContainText('Switch organization or sign in again');
  await expect(page.locator('.dashboard-cards')).toHaveCount(0);
  const denied = await page.request.get(`${f.baseUrl}/analytics/summary`, { headers });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).data).toBeUndefined();
  await switchTo(page, 'Dashboard Sales');
  await numbers(page, ['2', '1', '2']);
});
