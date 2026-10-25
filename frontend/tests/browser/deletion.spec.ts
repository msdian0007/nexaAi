import { test, expect, type Page } from "@playwright/test";

const row = { id: "document-1", organizationId: "o", originalName: "handbook.txt", status: "COMPLETED", processingState: "READY", canRetry: false,
  updatedAt: "2026-10-25T10:00:00Z", createdAt: "2026-10-25T09:00:00Z", size: 42, mimeType: "text/plain", errorMessage: null };
async function setup(page: Page, canDelete = true) {
  const state = { canDelete, deleted: false, cleanupPending: false, pendingResult: false, failure: 0, deletes: 0 };
  await page.route("**/api/v1/auth/login", route => route.fulfill({ json: { success: true, data: {
    token: "test-token", user: { id: "u", name: "Asha", email: "asha@example.invalid" }, organization: { id: "o", name: "Support", slug: "support" }, role: "OWNER",
  } } }));
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { success: true, data: { userId: "u", organizationId: "o", role: "OWNER" } } }));
  await page.route("**/api/v1/documents?*", route => route.fulfill({ json: { success: true, data: {
    organizationId: "o", canDelete: state.canDelete, documents: state.deleted ? [] : [{ ...row, processingState: state.cleanupPending ? "DELETING" : "READY" }],
    page: { limit: 10, hasMore: false, nextCursor: null },
  } } }));
  await page.route("**/api/v1/documents/document-1", route => {
    expect(route.request().method()).toBe("DELETE"); expect(route.request().headers().authorization).toBe("Bearer test-token");
    expect(route.request().postData()).toBeNull(); state.deletes++;
    if (state.failure) return route.fulfill({ status: state.failure, json: { success: false, message: "PRIVATE DETAIL" } });
    state.cleanupPending = state.pendingResult; state.deleted = !state.pendingResult;
    return route.fulfill({ status: state.pendingResult ? 202 : 200, json: { success: true, data: {
      documentId: row.id, organizationId: "o", deleted: state.deleted, cleanupPending: state.cleanupPending,
    } } });
  });
  await page.goto("/login"); await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("article", { name: "Document handbook.txt" })).toBeVisible();
  return state;
}

test("confirmation names the document and explains deletion; cancel sends no DELETE", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirm document deletion" })).toBeFocused();
  await expect(page.getByText(/permanently removes its stored file and searchable chunks/)).toContainText("Saved answers and their citation details remain");
  await page.getByRole("button", { name: "Cancel deletion" }).click();
  expect(state.deletes).toBe(0);
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByText(/Document, searchable chunks and stored file deleted/)).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0); expect(state.deletes).toBe(1);
});

test("server-reported permissions hide deletion despite an OWNER session", async ({ page }) => {
  await setup(page, false);
  await expect(page.getByRole("button", { name: "Delete handbook.txt" })).toHaveCount(0);
});

test("pending cleanup remains blocked and can be finished explicitly", async ({ page }) => {
  const state = await setup(page); state.pendingResult = true;
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByText(/Cleanup is pending/)).toBeVisible();
  await expect(page.getByText("Deletion pending — blocked from questions", { exact: true })).toBeVisible();
  state.pendingResult = false;
  await page.getByRole("button", { name: "Finish deletion of handbook.txt" }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("article")).toHaveCount(0); expect(state.deletes).toBe(2);
});

test("processing conflict and changed permissions require a fresh library read", async ({ page }) => {
  const state = await setup(page); state.failure = 409;
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("alert")).toContainText("being processed");
  await expect(page.getByRole("button", { name: "Delete handbook.txt" })).toHaveCount(0);
  state.failure = 403; await page.getByRole("button", { name: "Refresh library" }).click();
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("alert")).toContainText("permission to delete documents has changed");
  await expect(page.getByText("PRIVATE DETAIL")).toHaveCount(0); expect(state.deletes).toBe(2);
});

test("deleting the latest upload clears its panel and prevents polling it again", async ({ page }) => {
  await setup(page);
  await page.route("**/api/v1/documents/upload", route => route.fulfill({ status: 202, json: { success: true, data: row } }));
  await page.getByLabel("Select a document").setInputFiles({ name: "handbook.txt", mimeType: "text/plain", buffer: Buffer.from("Fixture") });
  await page.getByRole("button", { name: "Upload document", exact: true }).click();
  await expect(page.getByRole("region", { name: "Latest upload" })).toBeVisible();
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("region", { name: "Latest upload" })).toHaveCount(0);
});

test("a pending deletion blocks duplicate submission and ignores late results after navigation", async ({ page }) => {
  await setup(page); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  await page.route("**/api/v1/documents/document-1", async route => {
    calls++; await gate; await route.fulfill({ json: { success: true, data: { documentId: row.id, organizationId: "o", deleted: true, cleanupPending: false } } }).catch(() => {});
  });
  await page.getByRole("button", { name: "Delete handbook.txt", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(page.getByRole("button", { name: "Deleting..." })).toBeDisabled();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click(); release();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await expect(page.getByText(/Document, searchable chunks and stored file deleted/)).toHaveCount(0); expect(calls).toBe(1);
});
