import { createHash } from "node:crypto";
import type { Express, Response } from "express";
import type Redis from "ioredis";
import { createRedisConnection } from "../config/redis";
import prisma from "../config/database";
import {
  authenticate,
  type AuthenticatedRequest,
} from "../auth/auth.middleware";

export type Allowance = { key: string; limit: number; windowMs: number };
export type AdmissionStore = {
  consume: (rules: Allowance[]) => Promise<number>;
};
export type UsageBudgets = {
  aiOrganization: number;
  aiApplication: number;
  documentsOrganization: number;
};
const MINUTE = 60000,
  DAY = 86400000;

// Check ALL counters before charging any. Lua executes atomically in Redis, so
// simultaneous API processes cannot both spend the final available allowance.
// Windows start on first admission; rejected requests never extend their TTL.
const consumeScript = `
local wait = 0
for i, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count >= tonumber(ARGV[i * 2 - 1]) then
    local ttl = redis.call('PTTL', key)
    if ttl < 1 then ttl = tonumber(ARGV[i * 2]) end
    wait = math.max(wait, ttl)
  end
end
if wait > 0 then return wait end
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('PEXPIRE', key, ARGV[i * 2]) end
end
return 0
`;

export function createAdmissionStore(
  options: { url?: string; prefix?: string } = {},
) {
  const prefix = options.prefix ?? "nexaai:{admission}:v1";
  if (!/^[a-zA-Z0-9:{}-]{1,120}$/.test(prefix))
    throw new Error("Invalid admission namespace.");
  let client: Redis | undefined;
  let connecting: Promise<void> | undefined;
  return {
    async consume(rules: Allowance[]): Promise<number> {
      if (
        !rules.length ||
        rules.length > 8 ||
        rules.some(
          (rule) =>
            !rule.key ||
            !Number.isSafeInteger(rule.limit) ||
            rule.limit < 1 ||
            rule.limit > 1000000 ||
            !Number.isSafeInteger(rule.windowMs) ||
            rule.windowMs < 1 ||
            rule.windowMs > DAY,
        )
      )
        throw new Error("Invalid admission policy.");
      // Lazy connection keeps health, history, sign-out and workspace recovery
      // available during limiter outages. Expensive requests fail closed below.
      if (!client || client.status === "end")
        client = createRedisConnection(options.url);
      if (client.status === "wait") {
        connecting ??= client
          .connect()
          .then(() => undefined)
          .finally(() => {
            connecting = undefined;
          });
      }
      if (connecting) await connecting;
      if (client.status !== "ready")
        throw new Error("Admission store unavailable.");
      const keys = rules.map(
        (rule) =>
          `${prefix}:${createHash("sha256").update(rule.key).digest("hex")}`,
      );
      const result = await client.eval(
        consumeScript,
        keys.length,
        ...keys,
        ...rules.flatMap((rule) => [rule.limit, rule.windowMs]),
      );
      if (typeof result !== "number" || result < 0 || !Number.isFinite(result))
        throw new Error("Invalid admission result.");
      return Math.ceil(result / 1000);
    },
    async close() {
      const previous = client;
      client = undefined;
      previous?.disconnect();
    },
  };
}

export function usageBudgets(env = process.env): UsageBudgets {
  function setting(name: string, fallback: number) {
    const value = env[name];
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]{0,6}$/.test(value) || Number(value) > 1000000)
      throw new Error(`Invalid ${name}.`);
    return Number(value);
  }
  return {
    aiOrganization: setting("USAGE_AI_ORG_DAILY_LIMIT", 500),
    aiApplication: setting("USAGE_AI_APP_DAILY_LIMIT", 2000),
    documentsOrganization: setting("USAGE_DOCUMENT_ORG_DAILY_LIMIT", 100),
  };
}

let runtimeStore: ReturnType<typeof createAdmissionStore> | undefined;
const defaultStore: AdmissionStore = {
  consume: (rules) => (runtimeStore ??= createAdmissionStore()).consume(rules),
};
export async function closeAdmissionStore() {
  await runtimeStore?.close();
  runtimeStore = undefined;
}

export function installUsageAdmission(
  app: Express,
  store: AdmissionStore = defaultStore,
  budgets = usageBudgets(),
) {
  async function admit(res: Response, rules: Allowance[]) {
    try {
      const retryAfterSeconds = await store.consume(rules);
      if (!retryAfterSeconds) return true;
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res
        .status(429)
        .json({
          success: false,
          code: "RATE_LIMITED",
          message: "Request allowance reached. Retry after the indicated wait.",
          retryAfterSeconds,
        });
    } catch {
      // Never fall back to per-process memory or expose Redis connection details.
      res
        .status(503)
        .json({
          success: false,
          code: "USAGE_UNAVAILABLE",
          message:
            "Request allowance verification is unavailable. Please try again later.",
        });
    }
    return false;
  }
  const rule = (key: string, limit: number, windowMs: number): Allowance => ({
    key,
    limit,
    windowMs,
  });
  app.post(
    [
      "/api/v1/auth/login",
      "/api/v1/auth/register",
      "/api/v1/auth/register-invitation",
    ],
    async (req, res, next) => {
      // Express does not trust forwarded headers by default. Use the TCP peer,
      // rather than a caller-controlled X-Forwarded-For value, for public attempts.
      const peer = req.socket.remoteAddress ?? "unknown";
      if (
        await admit(res, [
          rule(`auth:minute:${peer}`, 20, MINUTE),
          rule(`auth:day:${peer}`, 200, DAY),
        ])
      )
        next();
    },
  );
  function protect(paths: string[], kind: "ai" | "documents") {
    app.post(
      paths,
      authenticate,
      async (req: AuthenticatedRequest, res, next) => {
        const { userId, organizationId } = req.user!;
        try {
          // Removed members cannot spend their former organization's allowance.
          const member = await prisma.organizationMember.findUnique({
            where: { userId_organizationId: { userId, organizationId } },
            select: { userId: true },
          });
          if (!member)
            return res
              .status(403)
              .json({
                success: false,
                code: "MEMBERSHIP_REQUIRED",
                message: "Current membership is required.",
              });
        } catch {
          return res
            .status(503)
            .json({
              success: false,
              code: "USAGE_UNAVAILABLE",
              message:
                "Request allowance verification is unavailable. Please try again later.",
            });
        }
        const rules =
          kind === "ai"
            ? [
                rule(`ai:user:${userId}`, 20, MINUTE),
                rule(`ai:org:minute:${organizationId}`, 60, MINUTE),
                rule(
                  `ai:org:day:${organizationId}`,
                  budgets.aiOrganization,
                  DAY,
                ),
                rule("ai:application:day", budgets.aiApplication, DAY),
              ]
            : [
                rule(`documents:user:${userId}`, 5, MINUTE),
                rule(
                  `documents:org:day:${organizationId}`,
                  budgets.documentsOrganization,
                  DAY,
                ),
              ];
        if (await admit(res, rules)) return next();
      },
    );
  }
  // The shared document allowance also covers the agent's confirmation route;
  // asking the agent to retry cannot bypass the upload/reprocessing budget.
  protect(
    [
      "/api/v1/chat/query",
      "/api/v1/documents/search",
      "/api/v1/agents/requests",
    ],
    "ai",
  );
  protect(
    [
      "/api/v1/documents/upload",
      "/api/v1/documents/:documentId/reprocess",
      "/api/v1/agents/proposals/:proposalId/confirm",
    ],
    "documents",
  );
}
