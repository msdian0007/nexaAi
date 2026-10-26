// Shared isolated HTTP fixture for API and Chrome integration tests. Provider text
// is deterministic, but auth, routes, executors, PostgreSQL and Redis are real.
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Queue } = require("bullmq");
const prisma = require("../../dist/src/config/database").default;
const provider = require("../../dist/src/rag/gemini.provider");
const {
  createDocumentQueue,
} = require("../../dist/src/document/document.queue");
const { createRedisConnection } = require("../../dist/src/config/redis");
const { createAdmissionStore } = require("../../dist/src/http/usage.admission");
let embeddingCalls = 0;
const vector = [1, ...Array(383).fill(0)];
const embeddingId =
  require.resolve("../../dist/src/document/document.embedding");
require.cache[embeddingId] = {
  id: embeddingId,
  filename: embeddingId,
  loaded: true,
  exports: { generateEmbedding: async () => { embeddingCalls++; return [...vector]; } },
};

async function startAgentFixture({ fullApi = false } = {}) {
  const initialEmbeddingCalls = embeddingCalls;
  const savedFactory = provider.createGeminiGenerator,
    savedAnswer = provider.generateGeminiText;
  const savedSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomUUID();
  const own = randomUUID(),
    foreign = randomUUID(),
    user = randomUUID(),
    peer = randomUUID(),
    outsider = randomUUID();
  const organizations = [],
    users = [];
  const queueName = `nexaai-agent-http-${randomUUID()}`;
  const admissionPrefix = `nexaai-test-security-${randomUUID()}`;
  const allowanceStore = createAdmissionStore({ prefix: admissionPrefix });
  const unavailableStore = createAdmissionStore({ prefix: admissionPrefix, url: 'redis://127.0.0.1:1' });
  const email = `${user}@example.invalid`,
    password = "FixturePassword123!";
  let producer, inspector, connection, server;
  const calls = { selection: 0, answer: 0 };
  const controls = { route: undefined, answer: undefined, admissionUnavailable: false };
  async function clearAllowances() {
    if (!connection || connection.status !== 'ready') return;
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', `${admissionPrefix}:*`, 'COUNT', 100);
      cursor = next;
      if (!keys.every(key => key.startsWith(`${admissionPrefix}:`))) throw new Error('Unsafe admission cleanup');
      if (keys.length) await connection.del(...keys);
    } while (cursor !== '0');
  }
  const decision = (kind, tool, message = "") =>
    JSON.stringify({ kind, tool, message });
  provider.createGeminiGenerator = () => async (messages) => {
    calls.selection++;
    if (controls.route) return controls.route(messages);
    const message = JSON.parse(messages[1].content).request;
    if (message.startsWith("Retry")) return decision("tool", "retry_document");
    if (message.includes("last month"))
      return decision(
        "clarification",
        "none",
        "Date filters are unavailable. Do you want current saved counts?",
      );
    if (message.includes("documents"))
      return decision("tool", "document_counts");
    if (message.includes("leave")) return decision("tool", "knowledge_answer");
    return decision("unsupported", "none", "This operation is unavailable.");
  };
  provider.generateGeminiText = async (messages) => {
    calls.answer++;
    if (controls.answer) return controls.answer(messages);
    return JSON.stringify({
      status: "answered",
      answer: "Employees receive **18 days** [S1].",
      citations: ["S1"],
    });
  };
  async function stop() {
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      await Promise.all([allowanceStore.close(), unavailableStore.close()]);
      await clearAllowances();
      await producer?.close();
      if (inspector) {
        assertQueueName();
        await inspector.obliterate();
        await inspector.close();
      }
    } finally {
      connection?.disconnect();
      provider.createGeminiGenerator = savedFactory;
      provider.generateGeminiText = savedAnswer;
      if (savedSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedSecret;
      try {
        await prisma.organization.deleteMany({
          where: { id: { in: organizations } },
        });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
        if (await prisma.organization.count({ where: { id: { in: organizations } } }) ||
            await prisma.user.count({ where: { id: { in: users } } })) throw new Error('Agent fixture record cleanup incomplete');
      } finally {
        await prisma.$disconnect();
      }
    }
  }
  function assertQueueName() {
    if (!/^nexaai-agent-http-[0-9a-f-]{36}$/.test(queueName))
      throw new Error("Unsafe fixture queue");
  }
  try {
    for (const id of [own, foreign]) {
      await prisma.organization.create({
        data: { id, name: "Agent HTTP fixture", slug: `agent-http-${id}` },
      });
      organizations.push(id);
    }
    const hash = await bcrypt.hash(password, 4);
    for (const id of [user, peer, outsider]) {
      await prisma.user.create({
        data: {
          id,
          name: "Agent fixture",
          email: `${id}@example.invalid`,
          password: hash,
        },
      });
      users.push(id);
    }
    for (const userId of [user, peer])
      await prisma.organizationMember.create({
        data: { userId, organizationId: own, role: "MEMBER" },
      });
    await prisma.organizationMember.create({
      data: { userId: outsider, organizationId: foreign, role: "OWNER" },
    });
    const documents = [];
    for (const [organizationId, status, name] of [
      [own, "COMPLETED", "handbook.txt"],
      [own, "FAILED", "retry-me.txt"],
      [foreign, "FAILED", "foreign-secret.txt"],
    ]) {
      const doc = await prisma.document.create({
        data: {
          organizationId,
          uploadedById: organizationId === own ? user : outsider,
          name: "private-storage-name",
          originalName: name,
          mimeType: "text/plain",
          size: 12,
          storagePath: "private/storage/path",
          status,
          chunks: {
            create: {
              chunkIndex: 0,
              content: "Employees receive 18 annual leave days.",
              embeddingStatus: status === "COMPLETED" ? "COMPLETED" : "FAILED",
            },
          },
        },
        include: { chunks: true },
      });
      if (status === "COMPLETED") {
        const encoded = `[${vector.join(",")}]`;
        await prisma.$executeRaw`UPDATE "DocumentChunk" SET "embedding" = ${encoded}::vector(384) WHERE id = ${doc.chunks[0].id}`;
      }
      documents.push(doc);
    }
    producer = await createDocumentQueue({ queueName });
    connection = createRedisConnection();
    await connection.connect();
    inspector = new Queue(queueName, { connection });
    inspector.on("error", () => {});
    // Full mode uses the shipped app, real scoped Redis admission and the
    // fixture's isolated queue. Existing focused router tests keep their setup.
    const app = fullApi ? require('../../dist/src/api').createApiApp({
      origins: ['http://127.0.0.1:4173'],
      admissionStore: { consume: rules => (controls.admissionUnavailable ? unavailableStore : allowanceStore).consume(rules) },
    }) : express();
    app.locals.getDocumentQueue = async () => producer;
    if (!fullApi) {
      app.use(cors());
      app.use(express.json());
      app.use("/api/v1/auth", require("../../dist/src/auth/auth.routes").default);
      app.use(
        "/api/v1/auth",
        require("../../dist/src/auth/auth.protected.route").default,
      );
      app.use(
        "/api/v1/agents",
        require("../../dist/src/agents/agent.routes").default,
      );
      app.use(
        "/api/v1/agents",
        require("../../dist/src/agents/agent.routes").agentJsonError,
      );
      app.use(
        "/api/v1/documents",
        require("../../dist/src/document/document.routes").default,
      );
    }
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
    const token = (userId = user, organizationId = own) =>
      jwt.sign(
        { userId, organizationId, role: "OWNER" },
        process.env.JWT_SECRET,
        { expiresIn: "10m" },
      );
    return {
      baseUrl,
      context: { userId: user, organizationId: own },
      peer,
      outsider,
      foreign,
      documents,
      producer,
      inspector,
      controls,
      calls,
      inferences: () => embeddingCalls - initialEmbeddingCalls,
      allowances: allowanceStore,
      clearAllowances,
      prisma,
      token,
      email,
      password,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
module.exports = { startAgentFixture };

if (require.main === module)
  void startAgentFixture({ fullApi: process.argv.includes('--full-api') })
    .then((fixture) => {
      // Only fixture identifiers/credentials go to the test parent; never real env settings.
      process.stdout.write(
        `${JSON.stringify({
          ready: true,
          baseUrl: fixture.baseUrl,
          email: fixture.email,
          password: fixture.password,
          retryId: fixture.documents[1].id,
        })}\n`,
      );
      let stopping = false;
      async function stop() {
        if (stopping) return;
        stopping = true;
        try { await fixture.stop(); process.exit(0); }
        catch { process.stderr.write('Agent fixture cleanup failed.\n'); process.exit(1); }
      }
      process.on("message", (message) => {
        if (message === "stop") void stop();
      });
      process.once("SIGTERM", () => void stop());
    })
    .catch(() => {
      process.stderr.write("Agent fixture failed to start.\n");
      process.exitCode = 1;
    });
