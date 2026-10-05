import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const session = {
  token: "test-token",
  user: { id: "u", name: "Asha", email: "asha@example.invalid" },
  organization: { id: "o", name: "Team", slug: "team" },
  role: "OWNER",
};
const identity = {
  success: true,
  data: { userId: "u", organizationId: "o", role: "OWNER" },
};

async function login(page: Page) {
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({ json: { success: true, data: session } }),
  );
  await page.goto("/login");
  await page.getByLabel("Email address").fill(session.user.email);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("direct protected access redirects, public routes and unknown URLs behave correctly", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/register$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();
  await page.goto("/not-a-page");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
});

test("dashboard waits for verification, then logout and browser back cannot reveal it", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-token");
    await gate;
    await route.fulfill({ json: identity });
  });
  await login(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("status")).toContainText("Checking your session");
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toHaveCount(0);
});

test("expired or mismatched identity returns to login with a reason", async ({
  page,
}) => {
  for (const mismatch of [false, true]) {
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill(
        mismatch
          ? {
              json: {
                success: true,
                data: { ...identity.data, organizationId: "other-tenant" },
              },
            }
          : { status: 401, json: { success: false } },
      ),
    );
    await login(page);
    await expect(page.getByRole("alert")).toContainText(
      mismatch ? "could not be verified" : "expired",
    );
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { name: "Welcome, Asha" }),
    ).toHaveCount(0);
    await page.unroute("**/api/v1/auth/me");
  }
});

test("service outage retains session for retry without another login", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/v1/auth/me", (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1
        ? { status: 503, json: { success: false } }
        : { json: identity },
    );
  });
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Unable to verify your session" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("signing out during verification prevents a late response restoring the session", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished!: () => void;
  const completed = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    await gate;
    await route.fulfill({ json: identity }).catch(() => {});
    finished();
  });
  await login(page);
  await expect(page.getByRole("status")).toContainText("Checking your session");
  await page.getByRole("button", { name: "Sign out" }).click();
  release();
  await completed;
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toHaveCount(0);
});
