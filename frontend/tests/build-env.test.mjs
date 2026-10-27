import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/validate-build-env.mjs", import.meta.url));
const run = (value, required = false) => spawnSync(process.execPath,
  [script, ...(required ? ["--required"] : [])], {
    env: { PATH: process.env.PATH, ...(value === undefined ? {} : { VITE_API_BASE_URL: value }) },
    encoding: "utf8",
  });

test("frontend API URL is optional locally and required for a container build", () => {
  assert.equal(run(undefined).status, 0);
  assert.equal(run(undefined, true).status, 1);
});

test("frontend accepts an API root and rejects credentials, queries and wrong paths", () => {
  assert.equal(run("https://api.example.test/api/v1", true).status, 0);
  for (const value of [
    "https://user:secret@api.example.test/api/v1",
    "https://api.example.test/api/v1?token=secret",
    "https://api.example.test/other",
    "javascript:alert(1)",
  ]) assert.equal(run(value, true).status, 1);
});
