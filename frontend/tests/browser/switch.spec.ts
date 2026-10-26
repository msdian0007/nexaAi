import { test, expect, type Page } from "../support/browser";

const first = { id: "o", name: "Support", slug: "support" };
const second = { id: "sales", name: "Sales", slug: "sales" };
const user = { id: "u", name: "Asha", email: "asha@example.invalid" };
async function setup(page: Page) {
  const state = { fail: 0, invalid: false, readsFail: false, writes: 0, choices: [{ organization: first, role: "OWNER" }, { organization: second, role: "MEMBER" }] };
  await page.route("**/api/v1/auth/login", route => route.fulfill({ json: { success: true, data: { token: "support-token", user, organization: first, role: "OWNER" } } }));
  await page.route("**/api/v1/auth/me", route => {
    const sales = route.request().headers().authorization === "Bearer sales-token";
    return route.fulfill({ json: { success: true, data: { userId: user.id, organizationId: sales ? second.id : first.id, role: sales ? "MEMBER" : "OWNER" } } });
  });
  await page.route("**/api/v1/auth/organizations", route => state.readsFail ? route.fulfill({ status: 503, json: { success: false } }) : route.fulfill({ json: { success: true, data: state.choices } }));
  await page.route("**/api/v1/auth/switch-organization", route => {
    state.writes++;
    expect(route.request().headers().authorization).toBe("Bearer support-token");
    expect(route.request().postDataJSON()).toEqual({ organizationId: second.id });
    return state.fail ? route.fulfill({ status: state.fail, json: { success: false } }) :
      route.fulfill({ json: { success: true, data: { token: "sales-token", user: state.invalid ? { ...user, id: "another-user" } : user, organization: second, role: "MEMBER" } } });
  });
  await page.goto("/login");
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
  return state;
}
async function openSwitcher(page: Page) {
  await page.getByRole("link", { name: "Switch organization", exact: true }).click();
  await expect(page.getByRole("button", { name: "Switch to Sales" })).toBeVisible();
}

test("switch issues new credentials and resets chat drafts and team history", async ({ page }) => {
  const state = await setup(page);
  const seen: string[] = [];
  await page.route("**/api/v1/chat/conversations?*", route => {
    const token = route.request().headers().authorization;
    seen.push(token);
    return route.fulfill({ json: { success: true, data: { conversations: [{
      id: token === "Bearer sales-token" ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111",
      title: token === "Bearer sales-token" ? "Sales only" : "Support only", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z",
    }], page: { hasMore: false, nextCursor: null } } } });
  });
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Support only", exact: true })).toBeVisible();
  await page.getByLabel("Your question").fill("Unsaved support question");
  await openSwitcher(page);
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByText("You are signed in to Sales.")).toBeVisible();
  await expect(page.getByText("MEMBER", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByLabel("Your question")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Sales only", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Support only", exact: true })).toHaveCount(0);
  expect(seen).toContain("Bearer sales-token"); expect(state.writes).toBe(1);
});

test("removed membership and malformed sessions keep the previous workspace selected", async ({ page }) => {
  const state = await setup(page); state.fail = 404;
  await openSwitcher(page);
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByRole("alert")).toContainText("membership is no longer available");
  await expect(page.getByText("Current workspace:")).toContainText("Support");
  state.fail = 0; state.invalid = true;
  await page.getByRole("button", { name: "Reload organizations" }).click();
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not switch organizations");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("You are signed in to Support.")).toBeVisible();
});

test("list errors can be reloaded and empty memberships are explained", async ({ page }) => {
  const state = await setup(page); state.readsFail = true;
  await page.getByRole("link", { name: "Switch organization", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load");
  state.readsFail = false; state.choices = [];
  await page.getByRole("button", { name: "Reload organizations" }).click();
  await expect(page.getByText(/You have no current memberships/)).toBeVisible();
});

test("pending switch prevents duplicates and signing out ignores its late result", async ({ page }) => {
  await setup(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route("**/api/v1/auth/switch-organization", async route => {
    writes++; await gate;
    await route.fulfill({ json: { success: true, data: { token: "sales-token", user, organization: second, role: "MEMBER" } } }).catch(() => {});
  });
  await openSwitcher(page);
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByRole("button", { name: "Switch to Sales" })).toBeDisabled();
  await page.getByRole("button", { name: "Sign out" }).click();
  release();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("You are signed in to Sales.")).toHaveCount(0);
  expect(writes).toBe(1);
});

test("switch verification hides pages until the target identity is verified", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await setup(page);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/auth/me", async route => {
    await gate;
    await route.fulfill({ json: { success: true, data: { userId: user.id, organizationId: second.id, role: "MEMBER" } } });
  });
  await openSwitcher(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByRole("status")).toContainText("Checking your session");
  await expect(page.getByText("You are signed in to Sales.")).toHaveCount(0);
  release();
  await expect(page.getByText("You are signed in to Sales.")).toBeVisible();
});
