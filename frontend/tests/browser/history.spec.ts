import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const summary = (id: string, title: string) => ({ id, title, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const source = { sourceId: 'S1', documentId: 'doc', chunkId: 'chunk', documentName: 'policy.txt', chunkIndex: 0, similarity: 0.8 };
const user = { id: randomUUID(), role: 'USER', content: 'Saved question', sequence: 0, answerStatus: null, sources: [], citations: [] };
const assistant = { id: randomUUID(), role: 'ASSISTANT', content: '18 days [S1].', sequence: 1, answerStatus: 'answered', sources: [source], citations: ['S1'] };
const end = { hasMore: false, nextCursor: null };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: {
    token: 'test-token', user: { id: 'u', name: 'Asha', email: 'asha@example.invalid' }, organization: { id: 'o', name: 'Team', slug: 'team' }, role: 'OWNER',
  } } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'o', role: 'OWNER' } } }));
  await page.route('**/api/v1/chat/conversations?*', route => route.fulfill({ json: { success: true, data: { conversations: [summary(a, 'Leave policy'), summary(b, 'Benefits')], page: end } } }));
  await page.goto('/login');
  await page.getByLabel('Email address').fill('asha@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
});

test('loads paginated messages and continues the selected conversation; new starts a separate thread', async ({ page }) => {
  await page.route(`**/chat/conversations/${a}/messages?*`, route => {
    const next = new URL(route.request().url()).searchParams.get('cursor');
    return route.fulfill({ json: { success: true, data: { conversation: summary(a, 'Leave policy'), messages: next ? [assistant] : [user], page: next ? end : { hasMore: true, nextCursor: 'next' } } } });
  });
  await page.getByRole('button', { name: 'Leave policy', exact: true }).click();
  await expect(page.getByText('Saved question', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Your question')).toBeDisabled();
  await page.getByRole('button', { name: 'Load more messages' }).click();
  await expect(page.getByText('[S1] policy.txt', { exact: true })).toBeVisible();
  let calls = 0;
  await page.route('**/chat/query', route => {
    const body = route.request().postDataJSON();
    expect(body.conversationId).toBe(calls++ === 0 ? a : undefined);
    return route.fulfill({ json: { success: true, data: { question: body.question, conversationId: body.conversationId || b,
      userMessageId: randomUUID(), assistantMessageId: randomUUID(), status: 'answered', answer: 'New answer [S1].', sources: [source], citations: ['S1'] } } });
  });
  await page.getByLabel('Your question').fill('Another complete question?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.locator('.answer-text')).toHaveCount(2);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.locator('.answer-panel')).toHaveCount(0);
  await page.getByLabel('Your question').fill('A separate question?');
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page.locator('.answer-text')).toHaveCount(1);
});

test('unavailable conversation blocks submission while a new conversation remains usable', async ({ page }) => {
  await page.route(`**/chat/conversations/${a}/messages?*`, route => route.fulfill({ status: 404, json: { success: false } }));
  await page.getByRole('button', { name: 'Leave policy', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This conversation is no longer available.');
  await expect(page.getByLabel('Your question')).toBeDisabled();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByLabel('Your question')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('list and message failures offer retry without losing loaded data', async ({ page }) => {
  let attempts = 0;
  await page.route('**/chat/conversations?*', route => {
    attempts++;
    if (new URL(route.request().url()).searchParams.get('cursor') === 'more') {
      return route.fulfill({ json: { success: true, data: { conversations: [summary(b, 'Benefits')], page: end } } });
    }
    return route.fulfill(attempts === 1 ? { status: 503, json: { success: false } } : { json: { success: true, data: { conversations: [summary(a, 'Leave policy')], page: { hasMore: true, nextCursor: 'more' } } } });
  });
  await page.getByRole('button', { name: 'Refresh conversations' }).click();
  await page.getByRole('button', { name: 'Retry conversations' }).click();
  await expect(page.getByRole('button', { name: 'Load more conversations' })).toBeVisible();
  await page.getByRole('button', { name: 'Load more conversations' }).click();
  await expect(page.getByRole('button', { name: 'Benefits', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more conversations' })).toHaveCount(0);
  await page.route(`**/chat/conversations/${a}/messages?*`, route => route.fulfill({ status: 503, json: { success: false } }));
  await page.getByRole('button', { name: 'Leave policy', exact: true }).click();
  await expect(page.getByLabel('Your question')).toBeDisabled();
  await page.route(`**/chat/conversations/${a}/messages?*`, route => route.fulfill({ json: { success: true, data: { conversation: summary(a, 'Leave policy'), messages: [user, assistant], page: end } } }));
  await page.getByRole('button', { name: 'Retry messages' }).click();
  await expect(page.getByLabel('Your question')).toBeEnabled();
});

test('switching selection ignores a delayed response from the previous conversation', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/chat/conversations/${a}/messages?*`, async route => {
    await gate;
    await route.fulfill({ json: { success: true, data: { conversation: summary(a, 'Leave policy'), messages: [user, assistant], page: end } } }).catch(() => {});
  });
  await page.route(`**/chat/conversations/${b}/messages?*`, route => route.fulfill({ json: { success: true, data: { conversation: summary(b, 'Benefits'), messages: [{ ...user, content: 'Benefits question' }], page: end } } }));
  await page.getByRole('button', { name: 'Leave policy', exact: true }).click();
  await expect(page.getByText('Loading messages...')).toBeVisible();
  await page.getByRole('button', { name: 'Benefits', exact: true }).click();
  release();
  await expect(page.getByText('Benefits question', { exact: false })).toBeVisible();
  await expect(page.getByText('Saved question', { exact: false })).toHaveCount(0);
});
