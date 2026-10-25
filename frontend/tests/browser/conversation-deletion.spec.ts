import { test, expect, type Page } from "@playwright/test";
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const stamp = "2026-10-25T09:00:00Z";
const summary = (id: string) => ({ id, title: id === a ? "Leave policy" : "Benefits", createdAt: stamp, updatedAt: stamp });
async function setup(page: Page) {
  const state = { deleted: new Set<string>(), writes: 0, failure: 0 };
  await page.route("**/api/v1/auth/login", route => route.fulfill({ json: { success: true, data: {
    token: "test-token", user: { id: "u", name: "Asha", email: "asha@example.invalid" }, organization: { id: "o", name: "Support", slug: "support" }, role: "MEMBER",
  } } }));
  await page.route("**/api/v1/auth/me", route => route.fulfill({ json: { success: true, data: { userId: "u", organizationId: "o", role: "MEMBER" } } }));
  await page.route("**/api/v1/chat/conversations?*", route => route.fulfill({ json: { success: true, data: {
    conversations: [a, b].filter(id => !state.deleted.has(id)).map(summary), page: { hasMore: false, nextCursor: null },
  } } }));
  await page.route("**/api/v1/chat/conversations/*/messages?*", route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    return route.fulfill({ json: { success: true, data: { conversation: summary(id), messages: [{
      id: "33333333-3333-4333-8333-333333333333", role: "USER", content: id === a ? "Saved leave question" : "Saved benefits question", sequence: 0, answerStatus: null, sources: [], citations: [],
    }], page: { hasMore: false, nextCursor: null } } } });
  });
  await page.route(/\/api\/v1\/chat\/conversations\/[a-f0-9-]+$/, route => {
    state.writes++; expect(route.request().method()).toBe("DELETE"); expect(route.request().postData()).toBeNull();
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    if (state.failure) return route.fulfill({ status: state.failure, json: { success: false, message: "PRIVATE ERROR" } });
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!; state.deleted.add(id);
    return route.fulfill({ json: { success: true, data: { conversationId: id, deleted: true } } });
  });
  await page.goto("/login"); await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Leave policy", exact: true })).toBeVisible();
  return state;
}
async function confirm(page: Page, title = "Leave policy") {
  await page.getByRole("button", { name: `Delete conversation: ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "Confirm conversation deletion", exact: true }).click();
}

test("cancel keeps the selected chat and draft; confirmation clears them and removes the list entry", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Leave policy", exact: true }).click();
  await expect(page.getByText("Saved leave question", { exact: false })).toBeVisible();
  await page.getByLabel("Your question").fill("Unsaved draft");
  await page.getByRole("button", { name: "Delete conversation: Leave policy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Delete conversation?" })).toBeFocused();
  await expect(page.getByText(/Uploaded documents are kept/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel conversation deletion" }).click();
  expect(state.writes).toBe(0); await expect(page.getByLabel("Your question")).toHaveValue("Unsaved draft");
  await confirm(page);
  await expect(page.getByRole("button", { name: "Leave policy", exact: true })).toHaveCount(0);
  await expect(page.getByText("Saved leave question", { exact: false })).toHaveCount(0);
  await expect(page.getByLabel("Your question")).toHaveValue("");
  await expect(page.getByText(/Conversation and its messages and saved source details deleted/)).toBeVisible(); expect(state.writes).toBe(1);
});

test("deleting a different chat preserves the open conversation and draft", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Leave policy", exact: true }).click();
  await expect(page.getByText("Saved leave question", { exact: false })).toBeVisible();
  await page.getByLabel("Your question").fill("Keep this draft");
  await confirm(page, "Benefits");
  await expect(page.getByRole("button", { name: "Benefits", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Your question")).toHaveValue("Keep this draft");
  await expect(page.getByText("Saved leave question", { exact: false })).toBeVisible();
});

test("uncertain deletion requires a fresh list read; stale membership errors stay controlled", async ({ page }) => {
  const state = await setup(page); state.failure = 503;
  await confirm(page);
  await expect(page.getByRole("alert")).toContainText("Could not confirm deletion");
  await expect(page.getByRole("button", { name: "Delete conversation: Leave policy", exact: true })).toBeDisabled();
  state.failure = 403; await page.getByRole("button", { name: "Refresh conversations" }).click();
  await confirm(page);
  await expect(page.getByRole("alert")).toContainText("membership no longer permits");
  await expect(page.getByText("PRIVATE ERROR")).toHaveCount(0); expect(state.writes).toBe(2);
});

test("a late answer cannot repopulate the cleared conversation after deletion", async ({ page }) => {
  await setup(page); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/chat/query", async route => {
    await gate;
    await route.fulfill({ json: { success: true, data: {
      question: "Continue this chat?", status: "insufficient_information", answer: "Late answer", sources: [], citations: [],
      conversationId: a, userMessageId: "44444444-4444-4444-8444-444444444444", assistantMessageId: "55555555-5555-4555-8555-555555555555",
    } } }).catch(() => {});
  });
  await page.getByRole("button", { name: "Leave policy", exact: true }).click();
  await expect(page.getByLabel("Your question")).toBeEnabled();
  await page.getByLabel("Your question").fill("Continue this chat?");
  await page.getByRole("button", { name: "Ask question", exact: true }).click();
  await expect(page.getByRole("button", { name: "Finding an answer..." })).toBeDisabled();
  await confirm(page); release();
  await expect(page.getByLabel("Your question")).toHaveValue("");
  await expect(page.getByText("Late answer", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave policy", exact: true })).toHaveCount(0);
});

test("pending deletion prevents duplicates and ignores its late result after leaving Chat", async ({ page }) => {
  await setup(page); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let writes = 0;
  await page.route(`**/api/v1/chat/conversations/${a}`, async route => {
    writes++; await gate; await route.fulfill({ json: { success: true, data: { conversationId: a, deleted: true } } }).catch(() => {});
  });
  await confirm(page);
  await expect(page.getByRole("button", { name: "Deleting conversation..." })).toBeDisabled();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click(); release();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  await expect(page.getByText(/Conversation and its messages and saved source details deleted/)).toHaveCount(0); expect(writes).toBe(1);
});

test("a conversation on an older page can be deleted and confirmation fits mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const state = await setup(page);
  await page.route("**/api/v1/chat/conversations?*", route => {
    const older = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({ json: { success: true, data: { conversations: older ? (state.deleted.has(b) ? [] : [summary(b)]) : [summary(a)], page: { hasMore: !older, nextCursor: older ? null : "more" } } } });
  });
  await page.getByRole("button", { name: "Refresh conversations" }).click();
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await page.getByRole("button", { name: "Delete conversation: Benefits", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Confirm conversation deletion" }).click();
  await expect(page.getByRole("button", { name: "Benefits", exact: true })).toHaveCount(0); expect(state.writes).toBe(1);
});
