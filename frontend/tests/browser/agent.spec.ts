import { test, expect } from "../support/browser";
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const documentId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const proposal = (state = 'PENDING', expiresAt = new Date(Date.now() + 300000).toISOString()) => ({
  id: proposalId, tool: 'retry_document', documentId, documentName: '<img src=x onerror=alert(1)>.txt', state, expiresAt,
});
const envelope = (result: unknown) => ({ success: true, data: { executionId: randomUUID(), result } });
const counts = { kind: 'tool_result', result: { tool: 'document_counts', data: { asOf: new Date().toISOString(), total: 3,
  byStatus: { UPLOADED: 0, PROCESSING: 0, COMPLETED: 2, FAILED: 1 } } } };
const user = { id: 'u', name: 'Asha', email: 'asha@example.invalid' };
const team = { id: 'o', name: 'Support', slug: 'support' };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/login', route => route.fulfill({ json: { success: true, data: { token: 'test-token', user, organization: team, role: 'MEMBER' } } }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'o', role: 'MEMBER' } } }));
  await page.route('**/api/v1/agents/executions', route => route.fulfill({ json: { success: true, data: { executions: [] } } }));
  await page.goto('/login');
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Agent', exact: true }).click();
});
async function ask(page: Page, text = 'How many documents failed?') {
  await page.getByLabel('Your agent request').fill(text);
  await page.getByRole('button', { name: 'Run agent', exact: true }).click();
}
async function preview(page: Page) {
  await page.route('**/agents/requests', route => route.fulfill({ json: envelope({ kind: 'action_proposal', proposal: proposal() }) }));
  await ask(page, `Retry ${documentId}`);
  await expect(page.getByRole('heading', { name: 'Review document retry' })).toBeVisible();
}

test('admission rejection shows the wait and permits only a manual confirmation retry', async ({ page }) => {
  let calls = 0;
  await page.route(`**/agents/proposals/${proposalId}/confirm`, route => {
    calls++;
    return calls === 1
      ? route.fulfill({ status: 429, json: { success: false, code: 'RATE_LIMITED', retryAfterSeconds: 18 } })
      : route.fulfill({ json: envelope({ tool: 'retry_document', data: { documentId, state: 'accepted' } }) });
  });
  await preview(page);
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Try again in 18 seconds');
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeEnabled();
  expect(calls).toBe(1);
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByText('Retry accepted for background processing.', { exact: false })).toBeVisible();
  expect(calls).toBe(2);
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
});
async function refreshRoutes(page: Page, state = 'CLAIMED', missing = false) {
  await page.route(`**/agents/proposals/${proposalId}`, route => route.fulfill({ json: { success: true, data: proposal(state) } }));
  await page.route(`**/agents/proposals/${proposalId}/document-status`, route => route.fulfill(missing
    ? { status: 404, json: { success: false } }
    : { json: { success: true, data: { id: documentId, originalName: 'file.txt', status: 'FAILED', updatedAt: new Date().toISOString(),
      errorMessage: null, processingState: 'QUEUED', canRetry: false } } }));
}

test('count, cited Markdown, clarification and unsupported responses render their own types safely', async ({ page }) => {
  const source = { sourceId: 'S1', documentId, chunkId: documentId, documentName: 'handbook.txt', chunkIndex: 0, similarity: 0.8 };
  const results = [counts, { kind: 'tool_result', result: { tool: 'knowledge_answer', data: {
    status: 'answered', answer: '**18 days** [S1].', citations: ['S1'], sources: [source],
  } } }, { kind: 'clarification', question: 'Do you want current counts?' }, { kind: 'unsupported', message: '<img src=x onerror=alert(1)>' }];
  let index = 0;
  await page.route('**/agents/requests', route => {
    expect(route.request().headers().authorization).toBe('Bearer test-token');
    expect(Object.keys(route.request().postDataJSON())).toEqual(['message']);
    return route.fulfill({ json: envelope(results[index++]) });
  });
  await ask(page, ' Count documents ');
  await expect(page.getByRole('heading', { name: 'Tool: Saved document counts' })).toBeFocused();
  await expect(page.getByRole('table')).toContainText('FAILED1');
  await expect(page.getByText('Total documents: 3')).toBeVisible();
  await ask(page, 'What is our leave policy?');
  await expect(page.locator('.answer-text strong')).toHaveText('18 days');
  await expect(page.getByText('[S1] handbook.txt', { exact: true })).toBeVisible();
  await ask(page, 'Count last month');
  await expect(page.getByText('Do you want current counts?', { exact: true })).toBeVisible();
  await ask(page, 'Unsupported request');
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-result img')).toHaveCount(0);
});

test('a proposal submits nothing until confirmation; cancellation is separate and escaped filenames remain literal', async ({ page }) => {
  let confirmations = 0, cancellations = 0;
  await page.route(`**/agents/proposals/${proposalId}/confirm`, route => { confirmations++; return route.abort(); });
  await page.route(`**/agents/proposals/${proposalId}/cancel`, route => {
    cancellations++; expect(route.request().postData()).toBeNull();
    return route.fulfill({ json: envelope(proposal('CANCELLED')) });
  });
  await preview(page);
  expect(confirmations).toBe(0);
  await expect(page.locator('.agent-result img')).toHaveCount(0);
  await expect(page.getByLabel('Your agent request')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel proposal', exact: true }).click();
  await expect(page.getByText('Proposal cancelled.', { exact: false })).toBeVisible();
  expect(cancellations).toBe(1); expect(confirmations).toBe(0);
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Your agent request')).toBeEnabled();
});

test('pending confirmation prevents duplicates and accepted work has a separate status read', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route(`**/agents/proposals/${proposalId}/confirm`, async route => {
    calls++; expect(route.request().postData()).toBeNull(); await gate;
    await route.fulfill({ json: envelope({ tool: 'retry_document', data: { documentId, state: 'accepted' } }) });
  });
  await refreshRoutes(page, 'ACCEPTED');
  await preview(page);
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
  release();
  await expect(page.getByText('Retry accepted for background processing.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh proposal and document status' }).click();
  await expect(page.getByText('Waiting for processing', { exact: true })).toBeVisible();
  expect(calls).toBe(1);
});

test('uncertain confirmation remains disabled even after a PENDING receipt; a fresh status read permits another request', async ({ page }) => {
  let calls = 0;
  await page.route(`**/agents/proposals/${proposalId}/confirm`, route => { calls++; return route.fulfill({ status: 503, json: { success: false, code: 'SUBMISSION_UNCONFIRMED' } }); });
  await refreshRoutes(page, 'PENDING');
  await preview(page);
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Refresh proposal and document status');
  await expect(page.getByLabel('Your agent request')).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh proposal and document status' }).click();
  await expect(page.getByLabel('Your agent request')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
  expect(calls).toBe(1);
});

test('changed/expired confirmation and a missing document recover through reads without repeating a mutation', async ({ page }) => {
  await page.route(`**/agents/proposals/${proposalId}/confirm`, route => route.fulfill({ status: 409, json: { success: false, code: 'DOCUMENT_CHANGED' } }));
  await refreshRoutes(page, 'REJECTED', true);
  await preview(page);
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh proposal and document status' }).click();
  await expect(page.getByText('The document is no longer available.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Your agent request')).toBeEnabled();
});

test('expired proposals cannot be confirmed and narrow screens contain long metadata', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/agents/requests', route => route.fulfill({ json: envelope({ kind: 'action_proposal', proposal: {
    ...proposal('PENDING', new Date(Date.now() - 1000).toISOString()), documentName: 'very-long-name-'.repeat(60),
  } }) }));
  await ask(page, `Retry ${documentId}`);
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
  await expect(page.getByText('— expired', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid counts, unknown results and provider failures preserve the draft and never invent a result', async ({ page }) => {
  await page.route('**/agents/requests', route => route.fulfill({ json: envelope(counts) }));
  await ask(page);
  await expect(page.getByText('Total documents: 3')).toBeVisible();
  for (const result of [{ ...counts, result: { tool: 'document_counts', data: { ...counts.result.data, total: 999 } } }, { kind: 'made_up' }]) {
    await page.route('**/agents/requests', route => route.fulfill({ json: envelope(result) }));
    await ask(page, 'Keep this draft');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Your agent request')).toHaveValue('Keep this draft');
    await expect(page.getByRole('region', { name: 'Agent result', exact: true })).toHaveCount(0);
  }
  await page.route('**/agents/requests', route => route.fulfill({ status: 503, json: { success: false } }));
  await ask(page, 'Provider unavailable');
  await expect(page.getByLabel('Your agent request')).toHaveValue('Provider unavailable');
});

test('bad acknowledgement cannot enable another confirmation; records can be refreshed and reviewed', async ({ page }) => {
  await page.route(`**/agents/proposals/${proposalId}/confirm`, route => route.fulfill({ json: envelope({ tool: 'retry_document', data: { documentId: randomUUID(), state: 'accepted' } }) }));
  await page.route('**/agents/executions', route => route.fulfill({ json: { success: true, data: { executions: [{
    id: randomUUID(), operation: 'CONFIRM', tool: 'retry_document', proposalId, outcome: 'UNCONFIRMED', startedAt: new Date().toISOString(), durationMs: 12,
  }] } } }));
  await preview(page);
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
  await expect(page.getByText('unconfirmed', { exact: false }).last()).toBeVisible();
  await refreshRoutes(page, 'PENDING');
  await page.getByRole('button', { name: 'Refresh proposal and document status' }).click();
  await expect(page.getByLabel('Your agent request')).toBeEnabled();
  await page.route('**/agents/requests', route => route.fulfill({ json: envelope(counts) }));
  await ask(page, 'Count documents');
  await expect(page.getByText('Total documents: 3')).toBeVisible();
  await page.getByRole('button', { name: 'Review proposal', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
});

test('leaving the page ignores a late answer and refresh restores the verified session', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/agents/requests', async route => { await gate; await route.fulfill({ json: envelope(counts) }).catch(() => {}); });
  await ask(page);
  await expect(page.getByRole('button', { name: 'Run agent', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click(); release();
  await page.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Agent result', exact: true })).toHaveCount(0);
  // Select the form control by role after navigation so the assertion cannot
  // accidentally resolve the visible label while React remounts the page.
  await expect(page.getByRole('textbox', { name: 'Your agent request' })).toHaveValue('');
  await page.reload();
  await expect(page).toHaveURL(/\/agent$/);
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent result', exact: true })).toHaveCount(0);
});

test('organization switching clears agent drafts, result and old execution records', async ({ page }) => {
  const next = { id: 'sales', name: 'Sales', slug: 'sales' };
  await page.route('**/agents/requests', route => route.fulfill({ json: envelope(counts) }));
  await ask(page);
  await expect(page.getByText('Total documents: 3')).toBeVisible();
  await page.getByLabel('Your agent request').fill('Old team draft');
  await page.route('**/auth/organizations', route => route.fulfill({ json: { success: true, data: [{ organization: team, role: 'MEMBER' }, { organization: next, role: 'MEMBER' }] } }));
  await page.route('**/auth/switch-organization', route => route.fulfill({ json: { success: true, data: { token: 'sales-token', user, organization: next, role: 'MEMBER' } } }));
  await page.route('**/auth/me', route => route.fulfill({ json: { success: true, data: { userId: 'u', organizationId: 'sales', role: 'MEMBER' } } }));
  await page.getByRole('link', { name: 'Switch organization', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to Sales' }).click();
  await expect(page.getByText('You are signed in to Sales.')).toBeVisible();
  await page.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page.getByLabel('Your agent request')).toHaveValue('');
  await expect(page.getByText('Total documents: 3')).toHaveCount(0);
});
