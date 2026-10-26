import { test, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Chrome completes real auth, counts, cited knowledge, cancellation, confirmed queuing and receipt recovery', async ({ page }) => {
  test.setTimeout(120000);
  const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));
  const helper = fileURLToPath(new URL('../../../backend/tests/helpers/agent.http-fixture.cjs', import.meta.url));
  // The path starts at frontend/tests/browser; go up to the repository root.
  // Exercise the shipped app and real Redis rate/usage counters as well as the
  // existing authenticated tools, private records and isolated document queue.
  const child = fork(helper, ['--full-api'], { cwd: backend, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  let closing = false;
  try {
    const fixture = await new Promise<{ baseUrl: string; email: string; password: string; retryId: string }>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Agent fixture startup timed out')), 45000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Agent fixture exited before ready')); });
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.ready === true) { clearTimeout(timer); resolve(value); }
          } catch { /* Ignore library startup messages; never print environment data. */ }
        }
      });
      child.stderr!.on('data', () => {});
    });
    // Proxy to the isolated local API. Response bodies come from the real routes,
    // not HTTP mocks. Only provider decisions/embeddings inside the fixture are controlled.
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url());
      const target = `${fixture.baseUrl}${url.pathname.split('/api/v1')[1]}${url.search}`;
      try {
        // Keep each proxy request on its own connection. Reusing an idle test
        // socket can race the local server's keep-alive close under load. Never
        // retry a failed transport automatically: it may already have written.
        const response = await route.fetch({ url: target, headers: { ...route.request().headers(), connection: 'close' } });
        await route.fulfill({ response });
      } catch (error) {
        // Closing the page cancels its final metadata refresh. Keep the fixture
        // alive through the journey; only suppress transport errors during teardown.
        if (!closing) throw error;
      }
    });
    async function login() {
      await page.getByLabel('Email address').fill(fixture.email);
      await page.getByLabel('Password', { exact: true }).fill(fixture.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('link', { name: 'Agent', exact: true }).click();
    }
    async function ask(message: string) {
      await page.getByLabel('Your agent request').fill(message);
      await page.getByRole('button', { name: 'Run agent', exact: true }).click();
    }
    await page.goto('/login'); await login();
    await ask('How many documents have saved FAILED status?');
    await expect(page.getByText('Total documents: 2')).toBeVisible();
    await ask('What is our leave policy?');
    await expect(page.locator('.answer-text strong')).toHaveText('18 days');
    await expect(page.getByText('[S1] handbook.txt', { exact: true })).toBeVisible();
    await ask(`Retry document ${fixture.retryId}`);
    await expect(page.getByRole('heading', { name: 'Review document retry' })).toBeVisible();
    await expect(page.getByText('retry-me.txt', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('agent-proposal.png'), fullPage: true });
    await page.getByRole('button', { name: 'Cancel proposal', exact: true }).click();
    await expect(page.getByText('Proposal cancelled.', { exact: false })).toBeVisible();
    await ask(`Retry document ${fixture.retryId}`);
    await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
    await expect(page.getByText('Retry accepted for background processing.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh proposal and document status' }).click();
    await expect(page.getByText('Waiting for processing', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Documents', exact: true }).click();
    const card = page.getByRole('article', { name: 'Document retry-me.txt', exact: true });
    await expect(card).toContainText('Waiting for processing');
    await expect(card).toContainText(fixture.retryId);
    await page.getByRole('link', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review proposal', exact: true }).first()).toBeVisible();
    await page.reload(); await expect(page).toHaveURL(/\/login$/); await login();
    await page.getByRole('button', { name: 'Review proposal', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Review document retry' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm retry', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Refresh proposal and document status' }).click();
    await expect(page.getByText('Waiting for processing', { exact: true })).toBeVisible();
  } finally {
    closing = true;
    await page.close();
    if (child.connected) child.send('stop');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Agent fixture cleanup timed out')), 20000);
      })]);
      expect(code).toBe(0);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }
});
