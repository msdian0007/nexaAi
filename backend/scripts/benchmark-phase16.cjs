// A bounded local measurement, not a production capacity claim. It exercises
// the shipped HTTP app with real PostgreSQL and Redis while provider output and
// embeddings use deterministic fixtures, so repeated runs are comparable.
const { performance } = require("node:perf_hooks");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const { startAgentFixture } = require("../tests/helpers/agent.http-fixture.cjs");

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    requests: values.length,
    minMs: +sorted[0].toFixed(2),
    medianMs: +pick(0.5).toFixed(2),
    p95Ms: +pick(0.95).toFixed(2),
    maxMs: +sorted.at(-1).toFixed(2),
  };
}

async function request(fixture, route, options = {}) {
  const started = performance.now();
  const response = await fetch(`${fixture.baseUrl}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${fixture.token()}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  if (response.status !== 200 || body.success !== true) throw new Error("Measured request failed.");
  return performance.now() - started;
}

async function main() {
  const fixture = await startAgentFixture({ fullApi: true, logSink: () => {} });
  const report = {
    measuredAt: new Date().toISOString(),
    profile: "One local Node API, local PostgreSQL/pgvector and Redis; deterministic provider and embedding fixtures.",
    limits: {
      sequentialRequests: 12,
      concurrentRequests: 5,
      perRequestDeadlineMs: 5000,
      meaning: "A correctness smoke measurement at five concurrent reads, not a production load or capacity guarantee.",
    },
  };
  try {
    // Warm startup paths before recording values.
    await request(fixture, "/health/ready");
    await request(fixture, "/documents/search", { method: "POST", body: JSON.stringify({ query: "What is our leave policy?" }) });
    await fixture.clearAllowances();
    const health = [], search = [];
    for (let index = 0; index < 12; index++) health.push(await request(fixture, "/health/ready"));
    for (let index = 0; index < 12; index++) {
      search.push(await request(fixture, "/documents/search", { method: "POST", body: JSON.stringify({ query: "What is our leave policy?" }) }));
    }
    await fixture.clearAllowances();
    const concurrentStarted = performance.now();
    await Promise.all(Array.from({ length: 5 }, () => request(fixture, "/documents/search", {
      method: "POST", body: JSON.stringify({ query: "What is our leave policy?" }),
    })));
    Object.assign(report, {
      readiness: summary(health),
      scopedSearch: summary(search),
      fiveConcurrentSearchesMs: +(performance.now() - concurrentStarted).toFixed(2),
      cacheInferenceCalls: fixture.inferences(),
    });
  } finally {
    await fixture.stop();
  }
  const target = path.join(__dirname, "../docs/phase-16-performance-latest.json");
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Phase 16 measurement written to ${target}`);
}

main().catch(() => {
  console.error("Phase 16 benchmark failed. No private request or configuration details printed.");
  process.exitCode = 1;
});
