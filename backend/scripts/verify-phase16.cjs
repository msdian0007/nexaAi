// Phase 16 local backend gate. Every ordinary *.test.cjs suite runs once in a
// stable order. Opt-in live Gemini/browser journeys stay separate because they
// spend provider quota or require an additional browser process.
const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const excluded = new Set([
  "conversation.live.e2e.test.cjs",
  "phase11.live.browser.test.cjs",
]);
const suites = readdirSync(path.join(__dirname, "../tests"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.cjs") && !excluded.has(entry.name))
  .map((entry) => `tests/${entry.name}`)
  .sort();

if (suites.length < 40 || new Set(suites).size !== suites.length) {
  throw new Error("Phase 16 suite discovery is incomplete or duplicated.");
}
console.log(`Phase 16 backend gate: ${suites.length} isolated test files.`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", ...suites], {
  stdio: "inherit",
});
if (result.error) {
  console.error("Phase 16 backend test runner could not start.");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
