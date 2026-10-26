// Synthetic question, local model only. Do not use private user questions in a
// benchmark report. Numbers describe this machine/run, not end-to-end latency.
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { generateEmbedding } = require('../dist/src/document/document.embedding');
const { createQueryEmbeddingCache } = require('../dist/src/document/document.query-embedding');

function summarize(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return { repetitions: times.length, medianMs: +((sorted[5] + sorted[6]) / 2).toFixed(3), minMs: +sorted[0].toFixed(3), maxMs: +sorted[11].toFixed(3) };
}
async function measure(work) {
  const times = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now(); await work(); times.push(performance.now() - start);
  }
  return summarize(times);
}
async function run() {
  const query = 'How many annual leave days do employees receive?';
  const organization = randomUUID();
  const start = performance.now(); await generateEmbedding(query);
  const warmupMs = +(performance.now() - start).toFixed(3);
  const uncached = await measure(() => generateEmbedding(query));
  let cachedInferenceCalls = 0;
  const cache = createQueryEmbeddingCache({ generate: async text => { cachedInferenceCalls++; return generateEmbedding(text); } });
  await cache.get(organization, query); // Report warm cache hits separately from the fill.
  const cached = await measure(() => cache.get(organization, query));
  if (cachedInferenceCalls !== 1) throw new Error('Repeated cache hits performed extra inference.');
  console.log(JSON.stringify({ warmupMs, uncached, cached, cachedInferenceCalls, cachedRequestsIncludingFill: 13 }, null, 2));
}
run().catch(() => { console.error('Query embedding benchmark failed. No request/configuration details printed.'); process.exitCode = 1; });
