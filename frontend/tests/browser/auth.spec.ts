import { test, expect } from "@playwright/test";

const session = {
  token: "fictional-test-token",
  user: { id: "u", name: "Asha", email: "asha@example.invalid" },
  organization: { id: "o", name: "Sample Team", slug: "sample-team" },
  role: "OWNER",
};

test("login shows returned identity, sign out clears it, and refresh loses the session", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/v1/auth/login", async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({
      email: session.user.email,
      password: "password123",
    });
    await route.fulfill({ json: { success: true, data: session } });
  });
  await page.goto("/");
  async function signIn() {
    await page.getByLabel("Email address").fill(session.user.email);
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome, Asha" }),
    ).toBeVisible();
  }
  await signIn();
  await expect(page.getByText("Sample Team", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await signIn();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(calls).toBe(2);
});

test("registration sends the organization and trims names without modifying the password", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/register", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      name: "Asha",
      organizationName: "Sample Team",
      email: session.user.email,
      password: " password123 ",
    });
    await route.fulfill({
      status: 201,
      json: { success: true, data: session },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Full name").fill(" Asha ");
  await page.getByLabel("Organization name").fill(" Sample Team ");
  await page.getByLabel("Email address").fill(session.user.email);
  await page.getByLabel("Password", { exact: true }).fill(" password123 ");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toBeVisible();
});

test("pending requests prevent resubmission; failed requests display an accessible error and unlock the form", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route("**/api/v1/auth/login", async (route) => {
    calls++;
    await gate;
    await route.fulfill({
      status: 401,
      json: { success: false, message: "private internal text" },
    });
  });
  await page.goto("/");
  await page.getByLabel("Email address").fill(session.user.email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Signing in…" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create an account" }),
  ).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText(
    "check your email and password",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});

test("registration rejects blank names and short passwords; mobile layout fits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Full name").fill("   ");
  await page.getByLabel("Organization name").fill("Sample Team");
  await page.getByLabel("Email address").fill(session.user.email);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Enter your name");
  await page.getByLabel("Full name").fill("Asha");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  expect(
    await page
      .getByLabel("Password", { exact: true })
      .evaluate((element: HTMLInputElement) => element.validity.tooShort),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
