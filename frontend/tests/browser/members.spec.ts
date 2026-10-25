import { test, expect, type Page } from "@playwright/test";

function member(id: string, userId: string, role: string, name: string) {
  return { id, userId, organizationId: "o", role, user: { id: userId, name, email: `${name.toLowerCase()}@example.invalid` } };
}
async function setup(page: Page, role = "OWNER") {
  const state = { members: [member("membership-1", "u", role, "Asha"), member("membership-2", "v", "MEMBER", "Ravi"), member("membership-3", "w", "ADMIN", "Meera")], writes: [] as { method: string; path: string; body: unknown }[], fail: 0, foreign: false };
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ json: { success: true, data: {
    token: "test-token", user: { id: "u", name: "Asha", email: "asha@example.invalid" },
    organization: { id: "o", name: "Sample Team", slug: "sample-team" }, role: "OWNER",
  } } }));
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { success: true, data: { userId: "u", organizationId: "o", role: "OWNER" } } }));
  await page.route("**/api/v1/organizations/profile", (route) => route.fulfill({ json: { success: true, data: {
    id: "o", name: "Sample Team", slug: "sample-team", role, canEdit: role === "OWNER", createdAt: "2026-10-25", updatedAt: "2026-10-25",
  } } }));
  await page.route("**/api/v1/organizations/members**", (route) => {
    const req = route.request();
    expect(req.headers().authorization).toBe("Bearer test-token");
    if (req.method() === "GET") return route.fulfill({ json: { success: true, data: state.foreign ? state.members.map((m) => ({ ...m, organizationId: "foreign" })) : state.members } });
    const body = req.postData() ? req.postDataJSON() : undefined;
    state.writes.push({ method: req.method(), path: new URL(req.url()).pathname, body });
    if (state.fail) return route.fulfill({ status: state.fail, json: { success: false, message: "PRIVATE ERROR" } });
    if (req.method() === "POST") state.members.push(member("membership-4", "x", body.role, "Nila"));
    if (req.method() === "PATCH") state.members[1].role = body.role;
    if (req.method() === "DELETE") state.members = state.members.filter((m) => m.id !== "membership-2");
    return route.fulfill({ json: { success: true, data: { message: "Success" } } });
  });
  await page.goto("/login");
  await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await page.getByRole("link", { name: "Members", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(3);
  return state;
}

test("owner adds a registered user and updates a membership using its ID", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Registered email").fill("nila@example.invalid");
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
  expect(state.writes[0].body).toEqual({ email: "nila@example.invalid", role: "MEMBER" });
  await page.getByLabel("Change role for ravi@example.invalid").selectOption("ADMIN");
  await page.getByRole("button", { name: "Confirm change" }).click();
  await expect(page.getByLabel("Change role for ravi@example.invalid")).toHaveValue("ADMIN");
  expect(state.writes[1]).toEqual({ method: "PATCH", path: "/api/v1/organizations/members/membership-2/role", body: { role: "ADMIN" } });
  await expect(page.getByRole("button", { name: "Remove asha@example.invalid" })).toHaveCount(0);
});

test("removal explains conversation deletion; cancel sends no DELETE", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Remove ravi@example.invalid" }).click();
  await expect(page.getByText(/permanently deletes their private conversations/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Remove ravi@example.invalid" }).click();
  await page.getByRole("button", { name: "Confirm change" }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  expect(state.writes).toEqual([{ method: "DELETE", path: "/api/v1/organizations/members/membership-2", body: undefined }]);
});

test("administrator only manages regular members despite owner login token", async ({ page }) => {
  await setup(page, "ADMIN");
  await expect(page.getByLabel("New member role").locator("option")).toHaveCount(1);
  await expect(page.getByLabel(/Change role for/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove meera@example.invalid" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove ravi@example.invalid" })).toBeVisible();
});

test("regular members have no management controls; layout fits mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await setup(page, "MEMBER");
  await expect(page.getByLabel("Registered email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("both owner promotion and owner addition warn before a write", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Change role for ravi@example.invalid").selectOption("OWNER");
  await expect(page.getByText(/cannot be demoted or removed/)).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Registered email").fill("nila@example.invalid");
  await page.getByLabel("New member role").selectOption("OWNER");
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText(/cannot be demoted or removed/)).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm change" }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
  expect(state.writes).toHaveLength(1);
});

test("revoked access disables mutations until reload; foreign lists are rejected", async ({ page }) => {
  const state = await setup(page);
  state.fail = 403;
  await page.getByLabel("Registered email").fill("nila@example.invalid");
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("permissions have changed");
  await expect(page.getByLabel("Registered email")).toHaveCount(0);
  state.foreign = true;
  await page.getByRole("button", { name: "Reload members" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load members");
  await expect(page.getByRole("article")).toHaveCount(0);
  state.foreign = false;
  state.members[0].role = "MEMBER";
  await page.getByRole("button", { name: "Reload members" }).click();
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByLabel("Registered email")).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test("an uncertain save is not retried and a pending write is disabled on navigation", async ({ page }) => {
  const state = await setup(page);
  state.fail = 503;
  await page.getByLabel("Registered email").fill("nila@example.invalid");
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm the change");
  expect(state.writes).toHaveLength(1);
  await page.getByRole("button", { name: "Reload members" }).click();
  await expect(page.getByRole("article")).toHaveCount(3);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/organizations/members", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    await gate;
    await route.fulfill({ json: { success: true, data: {} } }).catch(() => {});
  });
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add member", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  release();
  await expect(page.getByRole("heading", { name: "Welcome, Asha" })).toBeVisible();
  await expect(page.getByText("Member added.", { exact: true })).toHaveCount(0);
});
