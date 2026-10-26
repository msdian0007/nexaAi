import { test as base, expect } from "@playwright/test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

type Ready = {
  baseUrl: string;
  email: string;
  peerEmail: string;
  password: string;
  userId: string;
  peerId: string;
  organizationId: string;
  foreignId: string;
  secretId: string;
  from: string;
  yesterday: string;
  through: string;
  to: string;
  emptyFrom: string;
  emptyThrough: string;
};
type Command =
  | "add-activity"
  | "delete-retained"
  | "revoke"
  | "member"
  | "admin"
  | "stop";
export type DashboardFixture = Ready & {
  control: (command: Command) => Promise<void>;
};

export const test = base.extend<{ fixture: DashboardFixture; fullApi: boolean }>({
  fullApi: [false, { option: true }],
  fixture: async ({ page, fullApi }, provideFixture) => {
    const backend = fileURLToPath(
      new URL("../../../backend/", import.meta.url),
    );
    const helper = fileURLToPath(
      new URL(
        "../../../backend/tests/helpers/dashboard.http-fixture.cjs",
        import.meta.url,
      ),
    );
    const child = fork(helper, fullApi ? ["--full-api"] : [], {
      cwd: backend,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    let closing = false;
    // Correlate acknowledgements rather than sleeping after database mutations.
    const waiting = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >();
    child.on("message", (raw) => {
      const message = raw as {
        replyTo?: string;
        ok?: boolean;
        cleaned?: boolean;
      };
      if (!message.replyTo) return;
      const item = waiting.get(message.replyTo);
      if (item) {
        waiting.delete(message.replyTo);
        if (message.ok) item.resolve();
        else item.reject(new Error("Dashboard fixture command failed"));
      }
    });
    function control(command: Command): Promise<void> {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("Dashboard fixture command timed out"));
        }, 15000);
        waiting.set(id, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.send({ id, command });
      });
    }
    try {
      const ready = await new Promise<Ready>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Dashboard fixture startup timed out")),
          30000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Dashboard fixture exited before ready"));
        });
        child.on("message", (raw) => {
          if ((raw as { ready?: boolean }).ready) {
            clearTimeout(timer);
            resolve(raw as Ready);
          }
        });
      });
      // This is a transport proxy, not a response mock. Auth and summary bodies
      // come unchanged from real Express routes, JWT verification and PostgreSQL.
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        try {
          const response = await route.fetch({
            url: `${ready.baseUrl}${url.pathname.split("/api/v1")[1]}${url.search}`,
          });
          await route.fulfill({ response });
        } catch (error) {
          if (!closing && !page.isClosed()) throw error;
        }
      });
      await provideFixture({ ...ready, control });
    } finally {
      closing = true;
      await page.close();
      if (child.connected) {
        // The child verifies exact fixture IDs and all cascades are gone before
        // acknowledging stop. Cleanup failure must fail the test, not be hidden.
        try {
          await control("stop");
          expect(await exited).toBe(0);
        } finally {
          if (child.exitCode === null) child.kill();
        }
      } else {
        expect(await exited).toBe(0);
      }
    }
  },
});
export { expect };
