import { test, expect } from "@playwright/test";
const profile = {
  id: "o",
  name: "Sample Team",
  slug: "sample-team",
  role: "OWNER",
  canEdit: true,
  createdAt: "2026-10-25T08:00:00Z",
  updatedAt: "2026-10-25T08:00:00Z",
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          token: "test-token",
          user: { id: "u", name: "Asha", email: "asha@example.invalid" },
          organization: { id: "o", name: "Sample Team", slug: "sample-team" },
          role: "OWNER",
        },
      },
    }),
  );
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { userId: "u", organizationId: "o", role: "OWNER" },
      },
    }),
  );
  await page.goto("/login");
  await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toBeVisible();
});

test("owner loads, validates and saves a name; the dashboard receives the confirmed name", async ({
  page,
}) => {
  let saves = 0,
    reads = 0;
  await page.route("**/api/v1/organizations/profile", (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    if (route.request().method() === "PATCH") {
      saves++;
      expect(route.request().postDataJSON()).toEqual({ name: "Nexa Support" });
      return route.fulfill({
        json: { success: true, data: { ...profile, name: "Nexa Support" } },
      });
    }
    reads++;
    return route.fulfill({ json: { success: true, data: profile } });
  });
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  const input = page.getByLabel("Organization display name");
  await expect(input).toHaveValue("Sample Team");
  await input.fill("   ");
  await expect(
    page.getByRole("button", { name: "Save organization name" }),
  ).toBeDisabled();
  await input.fill("Bad\u0007name");
  await expect(
    page.getByRole("button", { name: "Save organization name" }),
  ).toBeDisabled();
  await input.fill(" Nexa Support ");
  await page.getByRole("button", { name: "Save organization name" }).click();
  await expect(page.getByRole("status")).toHaveText("Organization name saved.");
  await expect(input).toHaveValue("Nexa Support");
  expect(saves).toBe(1);
  expect(reads).toBe(1);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(
    page.getByText("You are signed in to Nexa Support."),
  ).toBeVisible();
});

test("server-reported member role is read-only even when the session claims OWNER", async ({
  page,
}) => {
  await page.route("**/api/v1/organizations/profile", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { ...profile, role: "MEMBER", canEdit: false },
      },
    }),
  );
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(
    page.getByText(
      "This profile is read-only for your role. Ask an owner to update the name.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Organization display name")).toHaveCount(0);
});

test("failed saves preserve the draft; revoked permission removes editing controls", async ({
  page,
}) => {
  let saves = 0;
  await page.route("**/api/v1/organizations/profile", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { success: true, data: profile } });
    return route.fulfill({
      status: ++saves === 1 ? 503 : 403,
      json: { success: false, message: "PRIVATE ERROR" },
    });
  });
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await page.getByLabel("Organization display name").fill("Draft name");
  await page.getByRole("button", { name: "Save organization name" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not confirm the save",
  );
  await expect(page.getByLabel("Organization display name")).toHaveValue(
    "Draft name",
  );
  await page.getByRole("button", { name: "Save organization name" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "permission to edit this profile has changed",
  );
  await expect(page.getByLabel("Organization display name")).toHaveCount(0);
  expect(saves).toBe(2);
});

test("load failures can be retried and foreign profile responses are rejected", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/v1/organizations/profile", (route) =>
    route.fulfill({
      json: {
        success: true,
        data:
          ++reads === 1
            ? { ...profile, id: "foreign-org", name: "Private Team" }
            : profile,
      },
    }),
  );
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load");
  await expect(page.getByText("Private Team")).toHaveCount(0);
  await page.getByRole("button", { name: "Reload profile" }).click();
  await expect(page.getByLabel("Organization display name")).toHaveValue(
    "Sample Team",
  );
});

test("leaving during a save ignores its late response", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/organizations/profile", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { success: true, data: profile } });
    await gate;
    await route
      .fulfill({
        json: { success: true, data: { ...profile, name: "Late name" } },
      })
      .catch(() => {});
  });
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await page.getByLabel("Organization display name").fill("Late name");
  await page.getByRole("button", { name: "Save organization name" }).click();
  await expect(page.getByRole("button", { name: "Saving..." })).toBeDisabled();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  release();
  await expect(
    page.getByText("You are signed in to Sample Team."),
  ).toBeVisible();
});
