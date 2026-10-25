import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const id = '11111111-1111-4111-8111-111111111111';
const summary = { id, title: 'Formatting example', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const source = { sourceId: 'S1', documentId: 'doc', chunkId: 'chunk', documentName: '**handbook** <img src=x>.txt', chunkIndex: 0, similarity: 0.8 };
const question = '**Explain** <img src=x onerror=alert(1)>';

// Exercise the real answer/history components with controlled provider text.
// API mocks avoid model quota and make malicious and delayed text reproducible.
async function openAnswer(page: Page, answer: string, stored: boolean) {
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: {
    token: 'test-token', user: { id: 'u', name: 'Asha', email: 'asha@example.invalid' },
    organization: { id: 'o', name: 'Team', slug: 'team' }, role: 'MEMBER',
  } } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'o', role: 'MEMBER' } } }));
  await page.route('**/chat/conversations?*', route => route.fulfill({ json: { success: true, data: {
    conversations: stored ? [summary] : [], page: { hasMore: false, nextCursor: null },
  } } }));
  await page.route(`**/chat/conversations/${id}/messages?*`, route => route.fulfill({ json: { success: true, data: {
    conversation: summary, page: { hasMore: false, nextCursor: null }, messages: [
      { id: randomUUID(), role: 'USER', content: question, sequence: 0, answerStatus: null, sources: [], citations: [] },
      { id: randomUUID(), role: 'ASSISTANT', content: answer, sequence: 1, answerStatus: 'answered', sources: [source], citations: ['S1'] },
    ],
  } } }));
  await page.route('**/chat/query', route => route.fulfill({ json: { success: true, data: {
    conversationId: id, userMessageId: randomUUID(), assistantMessageId: randomUUID(),
    question, status: 'answered', answer, sources: [source], citations: ['S1'],
  } } }));
  await page.goto('/login');
  await page.getByLabel('Email address').fill('asha@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  if (stored) await page.getByRole('button', { name: summary.title, exact: true }).click();
  else {
    await page.getByLabel('Your question').fill(question);
    await page.getByRole('button', { name: 'Ask question', exact: true }).click();
  }
  await expect(page.locator('.answer-text')).toBeVisible();
}

const formatted = [
  '# Leave policy', '', '**18 days** of *annual leave* [S1].', '',
  '- Ask your manager', '- Submit the form', '', '1. Sign in', '2. Select leave', '',
  '> Approval is required.', '', 'Use `leaveDays` in this example.', '',
  '```js', 'const leaveDays = 18;', '<script>alert("example")</script>', '```', '',
  '[Policy site](https://example.invalid/policy)',
].join('\n');

for (const stored of [false, true]) {
  test(`${stored ? 'saved' : 'new'} answer formats Markdown and keeps questions and sources as literal text`, async ({ page }) => {
    await openAnswer(page, formatted, stored);
    const answer = page.locator('.answer-text');
    await expect(answer.getByRole('heading', { name: 'Leave policy', level: 3 })).toBeVisible();
    await expect(answer.locator('strong')).toHaveText('18 days');
    await expect(answer.locator('em')).toHaveText('annual leave');
    await expect(answer.locator('ul li')).toHaveText(['Ask your manager', 'Submit the form']);
    await expect(answer.locator('ol li')).toHaveText(['Sign in', 'Select leave']);
    await expect(answer.locator('blockquote')).toContainText('Approval is required.');
    await expect(answer.locator('pre code')).toContainText('<script>alert("example")</script>');
    await expect(answer.locator('p code')).toHaveText('leaveDays');
    await expect(answer).toContainText('[S1]');
    await expect(answer.getByRole('link', { name: 'Policy site' })).toHaveAttribute('href', 'https://example.invalid/policy');
    await expect(page.locator('.asked-question')).toContainText(question);
    await expect(page.locator('.asked-question img, .asked-question em')).toHaveCount(0);
    await expect(page.locator('.source-list')).toContainText(`[S1] ${source.documentName}`);
    await expect(page.locator('.source-list img')).toHaveCount(0);
    if (!stored) await expect(page.getByRole('heading', { name: 'Answer found' })).toBeFocused();
  });

  test(`${stored ? 'saved' : 'new'} answer escapes HTML, blocks unsafe links and never fetches Markdown images`, async ({ page }) => {
    let imageRequests = 0;
    let dialogs = 0;
    page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
    await page.route('**://images.example.invalid/**', route => { imageRequests++; return route.abort(); });
    const malicious = [
      'Policy answer [S1].', '',
      '<script>alert(1)</script>', '', '<img src="https://images.example.invalid/raw" onerror="alert(1)">', '',
      '<svg onload="alert(1)"></svg>', '', '<iframe src="https://images.example.invalid/frame"></iframe>', '',
      '[JavaScript](javascript:alert%281%29)', '[Encoded](jav&#x61;script:alert%281%29)',
      '[Data](data:text/html,hello)', '[VBScript](vbscript:msgbox%281%29)',
      '[Relative](/documents)', '[Protocol relative](//images.example.invalid/link)', '[File](file:///etc/passwd)', '',
      '![Policy diagram](https://images.example.invalid/diagram.png)', '',
      '[Safe HTTPS](https://example.invalid/policy)', '[Safe HTTP](http://example.invalid/help)',
    ].join('\n');
    await openAnswer(page, malicious, stored);
    const answer = page.locator('.answer-text');
    await expect(answer.locator('script, img, svg, iframe, object, embed')).toHaveCount(0);
    await expect(answer).toContainText('<script>alert(1)</script>');
    await expect(answer).toContainText('[Image: Policy diagram]');
    await expect(answer.getByRole('link')).toHaveCount(2);
    for (const link of await answer.getByRole('link').all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(imageRequests).toBe(0);
    expect(dialogs).toBe(0);
  });
}

test('long code and links stay inside the answer on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAnswer(page, `${formatted}\n\n\`\`\`\n${'long_code_'.repeat(90)}\n\`\`\`\n\n[${'long_link_'.repeat(60)}](https://example.invalid)`, false);
  const code = page.locator('.answer-text pre').last();
  await expect(code).toBeVisible();
  expect(await code.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
