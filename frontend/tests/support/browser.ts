import { test as base, expect } from "@playwright/test";

// Isolated UI specs sign in with fictional tokens. Stub the landing dashboard's
// read so it cannot contact a developer's real API and expire that fake session.
// Specs can register a later route to test other responses. Integrated journeys
// keep importing Playwright directly and use their actual isolated API instead.
export const test = base.extend({
  page: async ({ page }, providePage) => {
    await page.route("**/api/v1/analytics/summary?*", (route) => {
      const params = new URL(route.request().url()).searchParams;
      const from = params.get("from")!,
        to = params.get("to")!;
      const start = Date.parse(`${from}T00:00:00Z`);
      const days = (Date.parse(`${to}T00:00:00Z`) - start) / 86400000;
      return route.fulfill({
        json: {
          success: true,
          data: {
            definitionVersion: 1,
            asOf: new Date().toISOString(),
            range: { from, to, days, timezone: "UTC" },
            currentDocuments: {
              scope: "organization",
              total: 0,
              byStatus: { UPLOADED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 },
            },
            personalActivity: {
              scope: "current_user",
              savedChatQuestions: 0,
              agentRequests: {
                total: 0,
                byOutcome: {
                  STARTED: 0,
                  SUCCEEDED: 0,
                  FAILED: 0,
                  UNCONFIRMED: 0,
                },
              },
            },
            daily: Array.from({ length: days }, (_, i) => ({
              date: new Date(start + i * 86400000).toISOString().slice(0, 10),
              organizationUploads: 0,
              ownSavedChatQuestions: 0,
              ownAgentRequests: 0,
            })),
          },
        },
      });
    });
    await providePage(page);
  },
});
export { expect };
export type { Page } from "@playwright/test";
