import { test, expect, type Page } from "@playwright/test";

const secret = "a".repeat(43);
const invitation = {
  id: "invitation-1",
  organizationId: "o",
  email: "ravi@example.invalid",
  role: "MEMBER",
  expiresAt: "2026-10-30T10:00:00Z",
  acceptedAt: null,
  revokedAt: null,
  createdAt: "2026-10-25T10:00:00Z",
};
async function authRoutes(page: Page, email = "asha@example.invalid") {
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          token: "test-token",
          user: { id: "u", name: "Asha", email },
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
}
async function login(
  page: Page,
  destination: "dashboard" | "invitation" = "dashboard",
) {
  await page.getByLabel("Email address").fill("asha@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name:
        destination === "dashboard"
          ? "Welcome, Asha"
          : "Accept organization invitation",
    }),
  ).toBeVisible();
}
async function clientNavigate(page: Page, path: string) {
  // BrowserRouter keeps authentication in memory, so change history without reloading the document.
  await page.evaluate((next) => {
    history.pushState({}, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("owner creates a one-time link and later list responses contain no token", async ({
  page,
}) => {
  await authRoutes(page);
  let created = false;
  let postBody: unknown;
  await page.route("**/api/v1/organizations/members", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          {
            id: "m1",
            userId: "u",
            organizationId: "o",
            role: "OWNER",
            user: { id: "u", name: "Asha", email: "asha@example.invalid" },
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/organizations/invitations", (route) => {
    if (route.request().method() === "POST") {
      created = true;
      postBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        json: { success: true, data: { invitation, token: secret } },
      });
    }
    return route.fulfill({
      json: {
        success: true,
        data: { role: "OWNER", invitations: created ? [invitation] : [] },
      },
    });
  });
  await page.goto("/login");
  await login(page);
  await clientNavigate(page, "/organization/invitations");
  await page.getByLabel("Recipient email").fill(" Ravi@example.invalid ");
  await page.getByLabel("Expires after").selectOption("14");
  await page.getByRole("button", { name: "Create invitation" }).click();
  await expect(page.getByLabel("One-time invitation link")).toHaveValue(
    new RegExp(`/invitations/accept\\?token=${secret}$`),
  );
  await expect(page.getByText(/will not show this secret again/)).toBeVisible();
  expect(postBody).toEqual({
    email: "ravi@example.invalid",
    role: "MEMBER",
    expiresInDays: 14,
  });
  await expect(page.getByText(/MEMBER · Active/)).toBeVisible();
});

test("administrator gets only MEMBER invitations and can revoke an active link", async ({
  page,
}) => {
  await authRoutes(page);
  let deleted = "";
  await page.route("**/api/v1/organizations/invitations**", (route) => {
    if (route.request().method() === "DELETE") {
      deleted = new URL(route.request().url()).pathname;
      return route.fulfill({
        json: {
          success: true,
          data: { ...invitation, revokedAt: new Date().toISOString() },
        },
      });
    }
    return route.fulfill({
      json: {
        success: true,
        data: { role: "ADMIN", invitations: [invitation] },
      },
    });
  });
  await page.goto("/login");
  await login(page);
  await clientNavigate(page, "/organization/invitations");
  await expect(
    page.getByLabel("Role after acceptance").locator("option"),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Revoke invitation for ravi@example.invalid" })
    .click();
  await expect(page.getByText(/can no longer be accepted/)).toBeVisible();
  expect(deleted).toBe("/api/v1/organizations/invitations/invitation-1");
});

test("acceptance preserves the link through sign-in and reports the new membership", async ({
  page,
}) => {
  await authRoutes(page, "ravi@example.invalid");
  let accepted = 0;
  await page.route("**/api/v1/organizations/invitations/accept", (route) => {
    accepted++;
    expect(route.request().postDataJSON()).toEqual({ token: secret });
    return route.fulfill({
      json: {
        success: true,
        data: {
          organization: { id: "invited-o", name: "Support Team" },
          role: "MEMBER",
        },
      },
    });
  });
  await page.goto(`/invitations/accept?token=${secret}`);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await login(page, "invitation");
  await expect(
    page.getByRole("heading", { name: "Accept organization invitation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("status")).toContainText(
    "joined Support Team as MEMBER",
  );
  await expect(page.getByRole("link", { name: "Choose organization" })).toBeVisible();
  expect(accepted).toBe(1);
});

test("a new recipient registers directly into the invited organization", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/register-invitation", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      name: "Ravi Kumar",
      email: "ravi@example.invalid",
      password: "password123",
      token: secret,
    });
    return route.fulfill({
      status: 201,
      json: {
        success: true,
        data: {
          token: "invited-session",
          user: { id: "r", name: "Ravi Kumar", email: "ravi@example.invalid" },
          organization: {
            id: "invited-o",
            name: "Support Team",
            slug: "support-team",
          },
          role: "MEMBER",
        },
      },
    });
  });
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { userId: "r", organizationId: "invited-o", role: "MEMBER" },
      },
    }),
  );
  await page.goto(`/invitations/accept?token=${secret}`);
  await page.getByRole("link", { name: "Create account" }).click();
  await expect(
    page.getByText("Create your account inside the invited organization."),
  ).toBeVisible();
  await expect(page.getByLabel("Organization name")).toHaveCount(0);
  await page.getByLabel("Full name").fill("Ravi Kumar");
  await page.getByLabel("Email address").fill("ravi@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByText("You are signed in to Support Team."),
  ).toBeVisible();
});
