import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const source = { sourceId: 'S1', documentId: 'doc', chunkId: 'chunk', documentName: 'handbook.txt', chunkIndex: 0, similarity: 0.8 };
const question = 'How much annual leave do employees receive?';

// Mock HTTP responses, not React state: these tests exercise the actual form,
// authenticated client, routing, and source rendering without spending model quota.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: {
    token: 'test-token', user: { id: 'u', name: 'Asha', email: 'asha@example.invalid' },
    organization: { id: 'o', name: 'Sample Team', slug: 'sample-team' }, role: 'OWNER',
  } } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'o', role: 'OWNER' } } }));
  await page.goto('/login');
  await page.getByLabel('Email address').fill('asha@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
});

async function ask(page: Page, text = question) {
  await page.getByLabel('Your question').fill(text);
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
}

test('sends a single trimmed question with token, blocks duplicates, and renders safe cited text', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/v1/chat/query', async route => {
    calls++;
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    expect(route.request().postDataJSON()).toEqual({ question });
    await gate;
    await route.fulfill({ json: { success: true, data: { question, status: 'answered',
      answer: '18 days [S1]. <img src=x onerror=alert(1)>', citations: ['S1'], sources: [source] } } });
  });
  await ask(page, ` ${question} `);
  await expect(page.getByRole('button', { name: 'Finding an answer...' })).toBeDisabled();
  release();
  await expect(page.getByRole('heading', { name: 'Answer found' })).toBeFocused();
  await expect(page.getByText('[S1] handbook.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('Passage 1', { exact: true })).toBeVisible();
  await expect(page.locator('.answer-text')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.answer-panel img')).toHaveCount(0);
  expect(calls).toBe(1);
});

test('distinguishes missing evidence, partial answers, and conflicting evidence', async ({ page }) => {
  const answers = [
    { status: 'insufficient_information', answer: 'No relevant information was found.', citations: [], sources: [] },
    { status: 'insufficient_information', answer: '18 days [S1]. Carry-over rules were not provided.', citations: ['S1'], sources: [source] },
    { status: 'conflicting_evidence', answer: 'One policy says 18 days [S1], another says 25 days [S2].', citations: ['S1', 'S2'],
      sources: [source, { ...source, sourceId: 'S2', documentName: 'other-policy.txt', chunkId: 'other' }] },
  ];
  let index = 0;
  await page.route('**/api/v1/chat/query', route => route.fulfill({ json: { success: true, data: { question, ...answers[index++] } } }));
  for (const answer of answers) {
    await ask(page);
    await expect(page.locator('.answer-text')).toHaveText(answer.answer);
    await expect(page.locator('.source-list li')).toHaveCount(answer.sources.length);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'Conflicting information' })).toBeVisible();
});

test('provider errors preserve the question for retry without inventing an answer; 401 logs out', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/chat/query', route => {
    calls++;
    return route.fulfill({ status: calls === 1 ? 503 : 401, json: { success: false, code: 'GENERATION_UNAVAILABLE' } });
  });
  await ask(page);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByLabel('Your question')).toHaveValue(question);
  await expect(page.locator('.answer-panel')).toHaveCount(0);
  expect(calls).toBe(1);
  await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('rejects invalid response mappings and limits input; narrow screen has no overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByLabel('Your question').fill('   ');
  await expect(page.getByRole('button', { name: 'Ask question', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Your question')).toHaveAttribute('maxlength', '1000');
  await page.route('**/api/v1/chat/query', route => route.fulfill({ json: { success: true,
    data: { question, status: 'answered', answer: '18 days [S99]', citations: ['S99'], sources: [source] } } }));
  await ask(page);
  await expect(page.getByRole('alert')).toContainText('could not be displayed');
  await expect(page.locator('.answer-panel')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('leaving chat ignores late results and direct signed-out access returns to login', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/chat/query', async route => {
    await gate;
    await route.fulfill({ json: { success: true, data: { question, status: 'answered', answer: '18 days [S1]', citations: ['S1'], sources: [source] } } }).catch(() => {});
  });
  await ask(page);
  await expect(page.getByRole('button', { name: 'Finding an answer...' })).toBeDisabled();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  release();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.answer-panel')).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});
