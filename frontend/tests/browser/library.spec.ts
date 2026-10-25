import { test, expect } from "@playwright/test";

const stamp = "2026-10-25T09:00:00Z";
const item = (id: string, name: string, state = "READY", organizationId = "o") => ({
  id, originalName: name, organizationId, status: state === "READY" ? "COMPLETED" : "PROCESSING",
  processingState: state, canRetry: false, errorMessage: null, size: 2048, mimeType: "text/plain", createdAt: stamp, updatedAt: stamp,
});
const response = (documents: unknown[], cursor: string | null = null, organizationId = "o") => ({ success: true, data: {
  organizationId, documents, page: { limit: 10, hasMore: !!cursor, nextCursor: cursor },
} });
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/login", route => route.fulfill({ json: { success: true, data: {
    token: "support-token", user: { id: "u", name: "Asha", email: "asha@example.invalid" }, organization: { id: "o", name: "Support", slug: "support" }, role: "OWNER",
  } } }));
  await page.route("**/api/v1/auth/me", route => {
    const sales = route.request().headers().authorization === "Bearer sales-token";
    return route.fulfill({ json: { success: true, data: { userId: "u", organizationId: sales ? "sales" : "o", role: sales ? "MEMBER" : "OWNER" } } });
  });
  await page.goto("/login");
  await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
});

test("lists old uploads, loads another page and restores the library after navigation", async ({ page }) => {
  const cursors: (string | null)[] = [];
  await page.route("**/api/v1/documents?*", route => {
    expect(route.request().headers().authorization).toBe("Bearer support-token");
    const cursor = new URL(route.request().url()).searchParams.get("cursor"); cursors.push(cursor);
    return route.fulfill({ json: cursor ? response([item("older", "Earlier handbook.txt", "RETRYING")]) : response([item("new", "Handbook.txt")], "more") });
  });
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  const library = page.getByRole("region", { name: "Document library" });
  await expect(library.getByRole("article")).toHaveCount(1);
  await expect(library.getByText("2 KiB", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Load more documents" }).click();
  await expect(library.getByRole("article")).toHaveCount(2);
  await expect(library.getByText("Retrying automatically", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more documents" })).toHaveCount(0);
  expect(cursors).toContain("more");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(library.getByRole("heading", { name: "Handbook.txt", exact: true })).toBeVisible();
});

test("a failed next page preserves cards and retries the same cursor; refresh resets the list", async ({ page }) => {
  let failing = true, refreshed = false;
  await page.route("**/api/v1/documents?*", route => {
    const after = new URL(route.request().url()).searchParams.get("cursor");
    if (after && failing) return route.fulfill({ status: 503, json: { success: false } });
    return route.fulfill({ json: after ? response([item("old", "Older.txt")]) : response([item("new", refreshed ? "Refreshed.txt" : "Original.txt")], "more") });
  });
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: "Load more documents" }).click();
  await expect(page.getByRole("alert")).toContainText("Previously loaded information is kept");
  await expect(page.getByRole("heading", { name: "Original.txt" })).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Retry library" }).click();
  await expect(page.getByRole("heading", { name: "Older.txt" })).toBeVisible();
  refreshed = true;
  await page.getByRole("button", { name: "Refresh library" }).click();
  await expect(page.getByRole("heading", { name: "Refreshed.txt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Older.txt" })).toHaveCount(0);
});

test("rejects a foreign response and can recover to an empty library", async ({ page }) => {
  let foreign = true;
  await page.route("**/api/v1/documents?*", route => route.fulfill({ json: foreign ? response([item("foreign", "Private Sales.txt", "READY", "sales")]) : response([]) }));
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load");
  await expect(page.getByText("Private Sales.txt")).toHaveCount(0);
  foreign = false; await page.getByRole("button", { name: "Retry library" }).click();
  await expect(page.getByText(/No saved documents yet/)).toBeVisible();
});

test("a saved upload reloads the library and shares its latest processing state", async ({ page }) => {
  let saved = false;
  const doc = item("uploaded", "policy.txt", "QUEUED");
  await page.route("**/api/v1/documents?*", route => route.fulfill({ json: response(saved ? [doc] : []) }));
  await page.route("**/api/v1/documents/upload", route => { saved = true; return route.fulfill({ status: 202, json: { success: true, data: doc } }); });
  await page.route("**/api/v1/documents/uploaded/status", route => route.fulfill({ json: { success: true, data: { ...doc, status: "COMPLETED", processingState: "READY", updatedAt: "2026-10-25T09:01:00Z" } } }));
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByText(/No saved documents yet/)).toBeVisible();
  await page.getByLabel("Select a document").setInputFiles({ name: "policy.txt", mimeType: "text/plain", buffer: Buffer.from("Policy text") });
  await page.getByRole("button", { name: "Upload document", exact: true }).click();
  const library = page.getByRole("region", { name: "Document library" });
  await expect(library.getByRole("heading", { name: "policy.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(library.getByText("Ready for questions", { exact: true })).toBeVisible();
});

test("switching teams clears the list and uses the new credentials; mobile cards fit", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.route("**/api/v1/documents?*", route => {
    const sales = route.request().headers().authorization === "Bearer sales-token";
    return route.fulfill({ json: sales ? response([item("sales-doc", "Sales.txt", "READY", "sales")], null, "sales") : response([item("support-doc", `${"LongFileName".repeat(12)}.txt`)]) });
  });
  await page.route("**/api/v1/auth/organizations", route => route.fulfill({ json: { success: true, data: [{ organization: { id: "sales", name: "Sales", slug: "sales" }, role: "MEMBER" }] } }));
  await page.route("**/api/v1/auth/switch-organization", route => route.fulfill({ json: { success: true, data: { token: "sales-token", user: { id: "u", name: "Asha", email: "asha@example.invalid" }, organization: { id: "sales", name: "Sales", slug: "sales" }, role: "MEMBER" } } }));
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Switch organization", exact: true }).click();
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByText("You are signed in to Sales.")).toBeVisible();
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sales.txt" })).toBeVisible();
  await expect(page.getByText(/LongFileName/)).toHaveCount(0);
});

test("leaving a pending library load ignores its late response", async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/documents?*", async route => { await gate; await route.fulfill({ json: response([item("late", "Late secret.txt")]) }).catch(() => {}); });
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByText("Loading document library...")).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click(); release();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await expect(page.getByText("Late secret.txt")).toHaveCount(0);
});
