// Opt-in LIVE evaluation: fictional indexed documents, real HTTP/retrieval/Gemini.
// Run from backend after building. Never included in the ordinary test suite.
require("dotenv/config");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;
const { generateEmbedding } = require("../dist/src/document/document.embedding");
const provider = require("../dist/src/rag/gemini.provider");
const router = require("../dist/src/rag/rag.routes").default;

const leave = "Full-time employees receive 18 days of paid annual leave per calendar year.";
const cases = [
  { id: "supported", documents: [leave], question: "How many days of paid annual leave do full-time employees receive per calendar year?",
    status: "answered", calls: 1, facts: [/\b18\b|eighteen/i], sources: 1 },
  { id: "unrelated", documents: [leave], question: "How far is Jupiter from the sun?",
    status: "insufficient_information", calls: 0, facts: [], sources: 0 },
  { id: "partial", documents: [leave], question: "How many days of paid annual leave do full-time employees receive, and how many unused annual leave days can they carry over to next year?",
    status: "insufficient_information", calls: 1, facts: [/\b18\b|eighteen/i, /carry|roll\s*over/i], sources: 1 },
  { id: "conflicting", documents: [leave, "Full-time employees receive 25 days of paid annual leave per calendar year."],
    question: "How many days of paid annual leave do full-time employees receive per calendar year?",
    status: "conflicting_evidence", calls: 1, facts: [/\b18\b|eighteen/i, /\b25\b|twenty.five/i], sources: 2 },
];
const tenants = [];
const originalSecret = process.env.JWT_SECRET;
const originalGenerator = provider.generateGeminiText;
const report = { startedAt: new Date().toISOString(), model: process.env.GEMINI_MODEL || provider.DEFAULT_GEMINI_MODEL,
  scope: "Real HTTP, JWT, PostgreSQL retrieval, local embeddings and Gemini; pre-indexed fictional fixtures (upload pipeline excluded).",
  reviewRequired: "Automated checks cover expected status, key facts, evidence isolation and source mapping. Read answers to assess factual support and limitations; a passing run is not proof of general reliability.",
  cases: [], cleanupCompleted: false };
let server, observed;

async function createTenant(documents) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, name: "RAG evaluation", email: `${id}@example.invalid`, password: "unused",
    memberships: { create: { role: "MEMBER", organization: { create: { id, name: "Fictional evaluation", slug: `rag-eval-${id}` } } } },
  } });
  tenants.push(id);
  const chunks = [];
  for (const [index, content] of documents.entries()) {
    const doc = await prisma.document.create({ data: {
      organizationId: id, uploadedById: id, name: "Fictional policy", originalName: `fictional-policy-${index + 1}.txt`,
      mimeType: "text/plain", size: Buffer.byteLength(content), storagePath: "evaluation-no-file",
      status: "COMPLETED", chunks: { create: { chunkIndex: 0, content, embeddingStatus: "COMPLETED" } },
    }, include: { chunks: true } });
    const chunk = doc.chunks[0];
    const vector = `[${(await generateEmbedding(content)).join(",")}]`;
    await prisma.$executeRaw`UPDATE "DocumentChunk" SET embedding = ${vector}::vector(384) WHERE id = ${chunk.id}`;
    chunks.push(chunk);
  }
  return { id, chunks, token: jwt.sign({ userId: id, organizationId: id, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "15m" }) };
}

async function main() {
  if (!process.env.GEMINI_API_KEY?.trim()) throw new Error("Configure GEMINI_API_KEY before running the live evaluation.");
  process.env.JWT_SECRET = randomUUID(); // Used only by this isolated, in-process HTTP server.
  provider.generateGeminiText = async messages => {
    observed.calls++;
    const input = JSON.parse(messages.find(message => message.role === "user").content);
    observed.evidence = input.evidence;
    // Check before sending: only this case's fictional excerpts may leave the process.
    if (input.evidence.some(entry => !observed.allowed.includes(entry.content))) {
      observed.isolationFailure = true;
      throw new Error("Unexpected evidence blocked by evaluation guard");
    }
    try { return await originalGenerator(messages); }
    catch (error) { observed.providerCode = error instanceof provider.GeminiProviderError ? error.code : "UNKNOWN"; throw error; }
  };
  const app = express();
  app.use(express.json());
  app.use("/api/v1/chat", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/v1/chat/query`;
  // A highly relevant distractor must never appear in another organization's evidence.
  const distractor = await createTenant(["Full-time employees receive 99 days of paid annual leave per calendar year. OTHER_ORGANIZATION_ONLY"]);
  for (const entry of cases) {
    console.log(`Evaluating ${entry.id}...`);
    const fixture = await createTenant(entry.documents);
    observed = { calls: 0, evidence: [], allowed: entry.documents, isolationFailure: false };
    const started = Date.now();
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${fixture.token}` },
      body: JSON.stringify({ question: entry.question, organizationId: distractor.id }), signal: AbortSignal.timeout(45000) });
    const body = await response.json();
    const answer = body.data;
    const checks = {
      httpSuccess: response.status === 200,
      expectedStatus: answer?.status === entry.status,
      expectedProviderCalls: observed.calls === entry.calls,
      evidenceIsolated: !observed.isolationFailure,
      keyFactsPresent: !!answer && entry.facts.every(pattern => pattern.test(answer.answer)),
      expectedSourceCount: answer?.sources?.length === entry.sources,
      sourcesBelongToFixture: !!answer && answer.sources.every(source => fixture.chunks.some(chunk =>
        chunk.id === source.chunkId && chunk.documentId === source.documentId &&
        observed.evidence.some(evidence => evidence.sourceId === source.sourceId && evidence.content === chunk.content))),
    };
    const result = { id: entry.id, question: entry.question, documents: entry.documents, expectedStatus: entry.status,
      httpStatus: response.status, providerCalls: observed.calls, providerCode: observed.providerCode,
      elapsedMs: Date.now() - started, evidence: observed.evidence, response: body, checks,
      passed: Object.values(checks).every(Boolean) };
    report.cases.push(result);
    console.log(JSON.stringify(result, null, 2));
    if (observed.providerCode) break; // Stop on transport/config/quota failure; no automatic retries.
  }
}

main().catch(() => { report.runError = "Evaluation could not complete; inspect configuration and local services. Raw errors omitted."; process.exitCode = 1; })
  .finally(async () => {
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const id of tenants) await prisma.$transaction([
        prisma.document.deleteMany({ where: { organizationId: id } }),
        prisma.organization.delete({ where: { id } }), prisma.user.delete({ where: { id } }),
      ]);
      report.cleanupCompleted = true;
    } catch { report.cleanupError = "Fixture cleanup failed"; report.remainingFixtureIds = tenants; process.exitCode = 1; }
    finally {
      provider.generateGeminiText = originalGenerator;
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
      report.completedAt = new Date().toISOString();
      report.passed = report.cases.length === cases.length && report.cases.every(result => result.passed) && report.cleanupCompleted && !report.runError;
      const file = path.join(__dirname, "../docs/rag-evaluation-latest.json");
      writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      console.log(`Evaluation ${report.passed ? "PASSED" : "FAILED"}; report: ${file}`);
      if (!report.passed) process.exitCode = 1;
    }
  });
