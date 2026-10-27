const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve('..');

test('environment variants and uploaded documents are ignored, while placeholder examples are shareable', () => {
  for (const file of ['.env', '.env.production', 'backend/.env.test', 'frontend/.env', 'frontend/.env.production', 'backend/uploads/documents/fixture/private.txt']) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], { cwd: repo });
    assert.equal(result.status, 0, `Expected private path to be ignored: ${file}`);
  }
  for (const example of ['.env.example', '.env.container.example', '.env.production.example']) {
    assert.equal(spawnSync('git', ['check-ignore', '--no-index', '--quiet', example], { cwd: repo }).status, 1);
  }
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' });
  assert.equal(tracked.status, 0);
  assert.equal(tracked.stdout.split('\0').some(file => /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.example')), false, 'A non-example environment file is already tracked; ignore rules do not remove tracked files.');
  assert.equal(tracked.stdout.split('\0').some(file => file.startsWith('backend/uploads/')), false, 'Uploaded files must be removed from the index as well as ignored.');
});

test('Compose requires a server-side database password instead of a checked-in value', () => {
  const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
  // Assert only a boolean: failing tests must never echo a credential value.
  assert.equal(/^\s*POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:\?[^}]+\}\s*$/m.test(compose), true);
});

test('embedding failure logs use fixed text and preserve the failure for retry handling', async () => {
  const embedding = require('../dist/src/document/document.embedding');
  const originalEmbedding = embedding.generateEmbedding, originalError = console.error;
  const failure = new Error('PRIVATE_DOCUMENT_AND_CREDENTIAL_CANARY');
  const logged = [];
  embedding.generateEmbedding = async () => { throw failure; };
  console.error = (...values) => logged.push(values);
  let marked = false;
  const db = { $queryRaw: async () => [{ id: 'fixture', content: 'fixture text', chunkIndex: 0 }],
    documentChunk: { update: async () => { marked = true; } } };
  try {
    const { embedDocumentChunks } = require('../dist/src/document/document.embedding.service');
    await assert.rejects(embedDocumentChunks('fixture-document', db), error => error === failure);
    assert.deepEqual(logged, [['Document chunk embedding failed.']]);
    assert.equal(marked, true);
  } finally { embedding.generateEmbedding = originalEmbedding; console.error = originalError; }
});
