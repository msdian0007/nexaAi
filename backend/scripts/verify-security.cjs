// Fixed, deduplicated local regression gate. Do not include live-Gemini journey
// scripts here: security verification should not spend a user's provider quota.
const { spawnSync } = require('node:child_process');
const suites = [
  'observability.telemetry', 'observability.integration',
  'security.combined.integration', 'security.review.integration', 'security.secret-boundaries',
  'usage.admission.integration', 'api.boundary.integration', 'auth.session.integration',
  'organization.permissions.integration', 'organization.profile.integration',
  'organization.invitations.integration', 'organization.switch.integration',
  'agent.contracts', 'agent.knowledge.integration', 'agent.document-counts.integration',
  'agent.routing', 'agent.routing.integration', 'agent.retry.integration', 'agent.http.integration',
  'document.query-embedding', 'document.query-cache.integration', 'document.search.integration',
  'document.library.integration', 'document.status.integration', 'document.deletion.integration',
  'document.reprocess.integration', 'document.processing.integration', 'document.worker.integration',
  'document.queue.runtime', 'conversation.history.integration', 'conversation.persistence.integration',
  'conversation.deletion.integration', 'rag.prompt', 'rag.response', 'rag.query.integration',
  'gemini.provider', 'dashboard.contracts', 'dashboard.summary.integration',
];
if (new Set(suites).size !== suites.length) throw new Error('Duplicate security suite.');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...suites.map(name => `tests/${name}.test.cjs`)], { stdio: 'inherit' });
if (result.error) { console.error('Security test runner could not start.'); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
