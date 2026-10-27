import { allowedOrigins } from "../http/api.boundary";
import { usageBudgets } from "../http/usage.admission";
import { getRedisUrl } from "./redis";
import { documentStorageConfig } from "../document/document.storage";

export type RuntimeRole = "api" | "worker" | "migration";

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required setting ${name} is missing.`);
  return value;
}

function databaseUrl(env: NodeJS.ProcessEnv) {
  const value = required(env, "DATABASE_URL");
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
        !url.username || !url.pathname || url.pathname === "/") throw new Error();
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
}

export function validateRuntimeConfig(role: RuntimeRole, env: NodeJS.ProcessEnv = process.env) {
  databaseUrl(env);
  if (role === "migration") return;
  getRedisUrl(required(env, "REDIS_URL"));
  documentStorageConfig(env);
  if (role === "worker") return;

  const nodeEnv = required(env, "NODE_ENV");
  if (!["development", "test", "production"].includes(nodeEnv))
    throw new Error("NODE_ENV must be development, test or production.");
  const secret = required(env, "JWT_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32 || /replace|example|changeme/i.test(secret))
    throw new Error("JWT_SECRET must be at least 32 bytes and must not be a placeholder.");
  const providerKey = required(env, "GEMINI_API_KEY");
  if (providerKey.length < 16 || /replace|example|changeme/i.test(providerKey))
    throw new Error("GEMINI_API_KEY is not configured correctly.");
  const port = env.PORT ?? "5000";
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
    throw new Error("PORT must be an integer from 1 to 65535.");
  // Reuse the same parsers used by requests so startup and runtime cannot
  // disagree about allowed origins or usage limits.
  allowedOrigins(env.API_ALLOWED_ORIGINS, nodeEnv);
  usageBudgets(env);
}
