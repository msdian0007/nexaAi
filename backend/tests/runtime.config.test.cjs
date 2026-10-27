const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateRuntimeConfig } = require("../dist/src/config/runtime");

const valid = () => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://nexaai:encoded-password@postgres:5432/nexaai",
  REDIS_URL: "redis://redis:6379/0",
  JWT_SECRET: "a-unique-secret-with-more-than-32-bytes",
  GEMINI_API_KEY: "synthetic-test-key-value",
  API_ALLOWED_ORIGINS: "https://app.example.test",
  PORT: "5000",
});

test("API configuration accepts explicit production settings", () => {
  assert.doesNotThrow(() => validateRuntimeConfig("api", valid()));
});

test("API configuration rejects missing, placeholder and malformed settings", () => {
  for (const [name, value] of [
    ["DATABASE_URL", "mysql://db/app"], ["REDIS_URL", "http://redis:6379"],
    ["JWT_SECRET", "replace-with-a-long-placeholder-secret"], ["GEMINI_API_KEY", "short"],
    ["API_ALLOWED_ORIGINS", "https://app.example.test/path"], ["PORT", "70000"],
  ]) {
    const env = valid(); env[name] = value;
    assert.throws(() => validateRuntimeConfig("api", env));
  }
  const absent = valid(); delete absent.JWT_SECRET;
  assert.throws(() => validateRuntimeConfig("api", absent));
  const missingOrigin = valid(); delete missingOrigin.API_ALLOWED_ORIGINS;
  assert.throws(() => validateRuntimeConfig("api", missingOrigin));
});

test("worker and migration roles require only the settings they use", () => {
  const worker = { DATABASE_URL: valid().DATABASE_URL, REDIS_URL: valid().REDIS_URL };
  assert.doesNotThrow(() => validateRuntimeConfig("worker", worker));
  assert.doesNotThrow(() => validateRuntimeConfig("migration", { DATABASE_URL: valid().DATABASE_URL }));
  assert.throws(() => validateRuntimeConfig("worker", { DATABASE_URL: valid().DATABASE_URL }));
  assert.throws(() => validateRuntimeConfig("migration", {}));
});
