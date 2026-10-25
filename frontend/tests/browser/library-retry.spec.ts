import { test, expect, type Page } from "@playwright/test";
const stamp = "2026-10-25T09:00:00Z";
function doc(id: string, state: string) {
  return { id, organizationId: "o", originalName: `${id}.txt`, status: state === "READY" ? "COMPLETED" : state === "FAILED" ? "FAILED" : "UPLOADED",
    processingState: state, canRetry: ["FAILED", "NOT_QUEUED"].includes(state), errorMessage: null,
    size: 42, mimeType: "text/plain", createdAt: stamp, updatedAt: stamp };
}
async function setup(page: Page, documents = [doc("older", "FAILED")]) {
  const state = { documents, posts: 0, reads: 0, failure: 0, readFailure: false, responses: [] as ReturnType<typeof doc>[] };
  await page.route("**/api/v1/auth/login", route => route.fulfill({ json: { success: true, data: {
    token: "member-token", user: { id: "u", name: "Asha", email: "asha@example.invalid" }, organization: { id: "o", name: "Support", slug: "support" }, role: "MEMBER",
  } } }));
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { success: true, data: { userId: "u", organizationId: "o", role: "MEMBER" } } }));
  await page.route("**/api/v1/documents?*", route => route.fulfill({ json: { success: true, data: {
    organizationId: "o", canDelete: false, documents: state.documents, page: { limit: 10, hasMore: false, nextCursor: null },
  } } }));
  await page.route("**/api/v1/documents/*/reprocess", route => {
    state.posts++; expect(route.request().method()).toBe("POST"); expect(route.request().postData()).toBeNull();
    expect(route.request().headers().authorization).toBe("Bearer member-token");
    if (state.failure) return route.fulfill({ status: state.failure, json: { success: false, message: "PRIVATE ERROR" } });
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    return route.fulfill({ status: 202, json: { success: true, data: doc(id, "QUEUED") } });
  });
  await page.route("**/api/v1/documents/*/status", route => {
    state.reads++;
    if (state.readFailure) return route.fulfill({ status: 503, json: { success: false } });
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    return route.fulfill({ json: { success: true, data: state.responses.shift() ?? doc(id, "READY") } });
  });
  await page.goto("/login"); await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Document library" })).toBeVisible();
  return state;
}

test("a regular member retries an older failed file and polls repeated unchanged states through Ready", async ({ page }) => {
  const state = await setup(page, [doc("ready", "READY"), doc("older", "FAILED")]);
  state.responses = [doc("older", "QUEUED"), doc("older", "RETRYING"), doc("older", "READY")];
  await page.getByRole("button", { name: "Retry processing older.txt", exact: true }).click();
  const card = page.getByRole("article", { name: "Document older.txt" });
  await expect(card.getByText("Waiting for processing", { exact: true })).toBeVisible();
  await expect(card.getByText("Ready for questions", { exact: true })).toBeVisible({ timeout: 12000 });
  expect(state.reads).toBe(3); expect(state.posts).toBe(1);
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Latest upload" })).toHaveCount(0);
});

test("only eligible files offer processing actions; a saved unqueued file starts without upload", async ({ page }) => {
  const rows = [doc("saved", "NOT_QUEUED"), doc("ready", "READY"), doc("waiting", "QUEUED"), doc("active", "PROCESSING"), doc("retrying", "RETRYING"), { ...doc("deleting", "DELETING"), canRetry: true }];
  const state = await setup(page, rows);
  await page.getByRole("button", { name: "Start processing saved.txt", exact: true }).click();
  await expect(page.getByRole("article", { name: "Document saved.txt" }).getByText("Waiting for processing", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Retry processing (ready|waiting|active|retrying|deleting)/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh processing status for deleting.txt" })).toHaveCount(0);
  expect(state.posts).toBe(1);
});

test("uncertain submission requires a status read before another retry", async ({ page }) => {
  const state = await setup(page); state.failure = 503;
  await page.getByRole("button", { name: "Retry processing older.txt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm the retry");
  await expect(page.getByRole("button", { name: "Retry processing older.txt", exact: true })).toBeDisabled();
  state.failure = 0; state.responses = [doc("older", "FAILED")];
  await page.getByRole("button", { name: "Refresh processing status for older.txt" }).click();
  await expect(page.getByRole("button", { name: "Retry processing older.txt", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry processing older.txt", exact: true }).click();
  await expect(page.getByText("Waiting for processing", { exact: true })).toBeVisible(); expect(state.posts).toBe(2);
});

test("poll errors retain the card and manual refresh resumes checks", async ({ page }) => {
  const state = await setup(page); state.readFailure = true;
  await page.getByRole("button", { name: "Retry processing older.txt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Automatic checks paused", { timeout: 7000 });
  await expect(page.getByRole("article")).toHaveCount(1);
  state.readFailure = false; state.responses = [doc("older", "PROCESSING"), doc("older", "READY")];
  await page.getByRole("button", { name: "Refresh processing status for older.txt" }).click();
  await expect(page.getByText("Ready for questions", { exact: true })).toBeVisible({ timeout: 7000 }); expect(state.posts).toBe(1);
});

test("a failed next-page file stays in place when its retry starts", async ({ page }) => {
  await setup(page);
  await page.route("**/api/v1/documents?*", route => route.fulfill({ json: { success: true, data: {
    organizationId: "o", documents: new URL(route.request().url()).searchParams.has("cursor") ? [doc("old-page", "FAILED")] : [doc("first", "READY")],
    page: { limit: 10, hasMore: !new URL(route.request().url()).searchParams.has("cursor"), nextCursor: new URL(route.request().url()).searchParams.has("cursor") ? null : "more" },
  } } }));
  await page.getByRole("button", { name: "Refresh library" }).click();
  await page.getByRole("button", { name: "Load more documents" }).click();
  await page.getByRole("button", { name: "Retry processing old-page.txt", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "first.txt", exact: true })).toBeVisible();
});

test("permission and state conflicts are safe and navigation ignores a pending retry response", async ({ page }) => {
  const state = await setup(page); state.failure = 403;
  await page.getByRole("button", { name: "Retry processing older.txt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("permission to process this document has changed");
  await expect(page.getByText("PRIVATE ERROR")).toHaveCount(0);
  state.responses = [doc("older", "FAILED")];
  await page.getByRole("button", { name: "Refresh processing status for older.txt" }).click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/documents/older/reprocess", async route => { await gate; await route.fulfill({ status: 202, json: { success: true, data: doc("older", "QUEUED") } }).catch(() => {}); });
  await page.getByRole("button", { name: "Retry processing older.txt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submitting... older.txt", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click(); release();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await expect(page.getByText("Waiting for processing", { exact: true })).toHaveCount(0);
});
