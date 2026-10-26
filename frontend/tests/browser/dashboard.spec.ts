import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const DAY = 86400000;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const user = { id: "u", name: "Asha", email: "asha@example.invalid" };
const organization = { id: "o", name: "Support", slug: "support" };
test.use({ timezoneId: "Asia/Kolkata" });

// HTTP fixtures match the versioned API contract. Real PostgreSQL aggregate
// verification is in backend/tests/dashboard.summary.integration.test.cjs.
function summary(url: string, empty = false) {
  const params = new URL(url).searchParams;
  const from = params.get("from")!,
    to = params.get("to")!;
  const start = Date.parse(from + "T00:00:00Z");
  const days = (Date.parse(to + "T00:00:00Z") - start) / DAY;
  const daily = Array.from({ length: days }, (_, i) => ({
    date: day(start + i * DAY),
    organizationUploads: !empty && i === 0 ? 2 : 0,
    ownSavedChatQuestions: !empty && i === 0 ? 2 : 0,
    ownAgentRequests: !empty && i === days - 1 ? 4 : 0,
  }));
  return {
    definitionVersion: 1,
    asOf: new Date().toISOString(),
    range: { from, to, days, timezone: "UTC" },
    currentDocuments: {
      scope: "organization",
      total: empty ? 0 : 3,
      byStatus: {
        UPLOADED: empty ? 0 : 1,
        PROCESSING: 0,
        COMPLETED: empty ? 0 : 1,
        FAILED: empty ? 0 : 1,
      },
    },
    personalActivity: {
      scope: "current_user",
      savedChatQuestions: empty ? 0 : 2,
      agentRequests: {
        total: empty ? 0 : 4,
        byOutcome: {
          STARTED: empty ? 0 : 1,
          SUCCEEDED: empty ? 0 : 1,
          FAILED: empty ? 0 : 1,
          UNCONFIRMED: empty ? 0 : 1,
        },
      },
    },
    daily,
  };
}
async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome, Asha" }),
  ).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { token: "test-token", user, organization, role: "MEMBER" },
      },
    }),
  );
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { userId: "u", organizationId: "o", role: "MEMBER" },
      },
    }),
  );
  await page.route("**/api/v1/analytics/summary?*", (route) =>
    route.fulfill({
      json: { success: true, data: summary(route.request().url()) },
    }),
  );
});

test("default seven-day summary sends only paired dates and renders scoped cards and exact daily values", async ({
  page,
}) => {
  const sent = page.waitForRequest("**/api/v1/analytics/summary?*");
  await signIn(page);
  const req = await sent;
  expect(req.headers().authorization).toBe("Bearer test-token");
  expect(req.postData()).toBeNull();
  const params = new URL(req.url()).searchParams;
  expect([...params.keys()].sort()).toEqual(["from", "to"]);
  expect(params.get("from")).toBe(day(today - 6 * DAY));
  expect(params.get("to")).toBe(day(today + DAY));
  await expect(
    page
      .getByRole("region", { name: "Current documents", exact: true })
      .locator(".dashboard-number"),
  ).toHaveText("3");
  await expect(
    page
      .getByRole("region", { name: "My saved questions", exact: true })
      .locator(".dashboard-number"),
  ).toHaveText("2");
  await expect(
    page
      .getByRole("region", { name: "My agent requests", exact: true })
      .locator(".dashboard-number"),
  ).toHaveText("4");
  await expect(
    page.getByRole("img", { name: "Daily retained activity in UTC" }),
  ).toBeVisible();
  await page.getByText("View daily values", { exact: true }).click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(7);
  await expect(
    page.getByRole("table").locator("tbody tr").first(),
  ).toContainText(day(today - 6 * DAY));
  await expect(
    page.getByRole("table").locator("tbody tr").last(),
  ).toContainText(day(today));
});

test("inclusive date selection converts to exclusive UTC end and single-day chart works", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "Apply dates" })).toBeEnabled();
  await page.getByLabel("From (UTC)", { exact: true }).fill(day(today - DAY));
  await page
    .getByLabel("Through (UTC, included)", { exact: true })
    .fill(day(today - DAY));
  const sent = page.waitForRequest("**/api/v1/analytics/summary?*");
  await page.getByRole("button", { name: "Apply dates" }).click();
  const params = new URL((await sent).url()).searchParams;
  expect(params.get("from")).toBe(day(today - DAY));
  expect(params.get("to")).toBe(day(today));
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  await expect(page.locator(".activity-chart circle")).toHaveCount(3);
  await expect(
    page
      .getByRole("region", { name: "Current documents", exact: true })
      .locator(".dashboard-number"),
  ).toHaveText("3");
  await page.getByText("View daily values", { exact: true }).click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await expect(page.getByLabel("From (UTC)", { exact: true })).toHaveValue(
    day(today - 6 * DAY),
  );
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
});

test("invalid and overlong ranges make no request; 90 days is accepted", async ({
  page,
}) => {
  let calls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/analytics/summary")) calls++;
  });
  await signIn(page);
  await expect(page.getByRole("button", { name: "Apply dates" })).toBeEnabled();
  // React StrictMode can start then abort the initial development-only read.
  // Compare with the settled baseline, rather than assuming one mount request.
  const initialCalls = calls;
  await page
    .getByLabel("From (UTC)", { exact: true })
    .fill(day(today - 90 * DAY));
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(page.getByRole("alert")).toContainText("1 to 90 UTC days");
  expect(calls).toBe(initialCalls);
  await page.getByLabel("From (UTC)", { exact: true }).fill(day(today));
  await page
    .getByLabel("Through (UTC, included)", { exact: true })
    .fill(day(today - DAY));
  await page.getByRole("button", { name: "Apply dates" }).click();
  expect(calls).toBe(initialCalls);
  await page
    .getByLabel("From (UTC)", { exact: true })
    .fill(day(today - 89 * DAY));
  await page
    .getByLabel("Through (UTC, included)", { exact: true })
    .fill(day(today));
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  await page.getByText("View daily values", { exact: true }).click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(90);
  expect(calls).toBe(initialCalls + 1);
});

test("pending refresh clears stale cards and disables duplicate submissions", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/analytics/summary?*", async (route) => {
    await gate;
    await route.fulfill({
      json: { success: true, data: summary(route.request().url(), true) },
    });
  });
  await page.getByRole("button", { name: "Refresh summary" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Loading workspace summary",
  );
  await expect(
    page.getByRole("button", { name: "Apply dates" }),
  ).toBeDisabled();
  await expect(page.locator(".dashboard-cards")).toHaveCount(0);
  release();
  await expect(
    page.getByText("No retained activity in this date range."),
  ).toBeVisible();
  await expect(page.locator(".dashboard-number")).toHaveText(["0", "0", "0"]);
});

test("outage clears old metrics, exposes no server detail and retry restores the summary", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  await page.route("**/api/v1/analytics/summary?*", (route) =>
    route.fulfill({
      status: 503,
      json: { success: false, message: "private SQL password" },
    }),
  );
  await page.getByRole("button", { name: "Refresh summary" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "service is currently unavailable",
  );
  await expect(page.locator(".dashboard-cards")).toHaveCount(0);
  await expect(page.getByText("private SQL password")).toHaveCount(0);
  await page.route("**/api/v1/analytics/summary?*", (route) =>
    route.fulfill({
      json: { success: true, data: summary(route.request().url()) },
    }),
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".dashboard-number")).toHaveText(["3", "2", "4"]);
});

test("invalid response totals, missing days, dates and unbounded counts never render metrics", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  for (const change of [
    (s: ReturnType<typeof summary>) => {
      s.currentDocuments.total = 99;
    },
    (s: ReturnType<typeof summary>) => {
      s.daily.pop();
    },
    (s: ReturnType<typeof summary>) => {
      s.range.from = "2000-01-01";
    },
    (s: ReturnType<typeof summary>) => {
      s.daily[0].organizationUploads = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    await page.route("**/api/v1/analytics/summary?*", (route) => {
      const s = summary(route.request().url());
      change(s);
      return route.fulfill({ json: { success: true, data: s } });
    });
    const refresh = page.getByRole("button", { name: "Refresh summary" });
    if (await refresh.count()) await refresh.click();
    else
      await page
        .getByRole("button", { name: "Try again", exact: true })
        .click();
    await expect(page.getByRole("alert")).toContainText(
      "dashboard response was invalid",
    );
    await expect(page.locator(".dashboard-cards")).toHaveCount(0);
  }
});

test("revoked membership shows recovery guidance and expiry returns to sign-in", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  await page.route("**/api/v1/analytics/summary?*", (route) =>
    route.fulfill({ status: 403, json: { success: false } }),
  );
  await page.getByRole("button", { name: "Refresh summary" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Switch organization or sign in again",
  );
  await expect(page.locator(".dashboard-cards")).toHaveCount(0);
  await page.route("**/api/v1/analytics/summary?*", (route) =>
    route.fulfill({ status: 401, json: { success: false } }),
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});

test("mobile page stays within the viewport and daily values remain keyboard accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  await page.getByText("View daily values", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("region", { name: "Daily activity table", exact: true }),
  ).toHaveAttribute("tabindex", "0");
});

test("late response after sign-out cannot restore private cards", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/analytics/summary?*", async (route) => {
    await gate;
    await route
      .fulfill({
        json: { success: true, data: summary(route.request().url()) },
      })
      .catch(() => {});
  });
  const sent = page.waitForRequest("**/api/v1/analytics/summary?*");
  await page.getByRole("button", { name: "Refresh summary" }).click();
  await sent;
  await page.getByRole("button", { name: "Sign out" }).click();
  release();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(page.locator(".dashboard-cards")).toHaveCount(0);
});

test("organization switch replaces cards and date drafts and ignores the old pending response", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("button", { name: "Refresh summary" }),
  ).toBeVisible();
  await page
    .getByLabel("From (UTC)", { exact: true })
    .fill(day(today - 30 * DAY));
  const sales = { id: "sales", name: "Sales", slug: "sales" };
  await page.route("**/api/v1/auth/organizations", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          { organization, role: "MEMBER" },
          { organization: sales, role: "MEMBER" },
        ],
      },
    }),
  );
  await page.route("**/api/v1/auth/switch-organization", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          token: "sales-token",
          user,
          organization: sales,
          role: "MEMBER",
        },
      },
    }),
  );
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          userId: user.id,
          organizationId:
            route.request().headers().authorization === "Bearer sales-token"
              ? sales.id
              : organization.id,
          role: "MEMBER",
        },
      },
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/analytics/summary?*", async (route) => {
    const isSales =
      route.request().headers().authorization === "Bearer sales-token";
    if (!isSales) await gate;
    await route
      .fulfill({
        json: { success: true, data: summary(route.request().url(), isSales) },
      })
      .catch(() => {});
  });
  const sent = page.waitForRequest("**/api/v1/analytics/summary?*");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await sent;
  await page
    .getByRole("link", { name: "Switch organization", exact: true })
    .click();
  await page.getByRole("button", { name: "Switch to Sales" }).click();
  await expect(page.getByText("You are signed in to Sales.")).toBeVisible();
  await expect(page.locator(".dashboard-number")).toHaveText(["0", "0", "0"]);
  release();
  await expect(page.getByLabel("From (UTC)", { exact: true })).toHaveValue(
    day(today - 6 * DAY),
  );
  await expect(page.locator(".dashboard-number")).toHaveText(["0", "0", "0"]);
});
