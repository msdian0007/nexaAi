// Real TXT upload, extraction, chunking, local embeddings, and PostgreSQL.
// Requires the local database and embedding model; run from backend after building.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;
const router = require("../dist/src/document/document.routes").default;

test("a real upload completes with extracted text, chunks, and 384-dimensional vectors", { timeout: 180000 }, async t => {
  const id = randomUUID();
  const uploadRoot = path.resolve("uploads", "documents");
  const testDirectory = path.resolve(uploadRoot, id);
  assert.equal(path.dirname(testDirectory), uploadRoot);
  const originalSecret = process.env.JWT_SECRET;
  let created = false;
  let server;
  try {
    process.env.JWT_SECRET = randomUUID();
    await prisma.user.create({
      data: {
        id, name: "Pipeline test", email: `${id}@example.invalid`, password: "unused",
        memberships: { create: {
          role: "MEMBER",
          organization: { create: { id, name: "Pipeline test", slug: `pipeline-test-${id}` } },
        } },
      },
    });
    created = true;
    const token = jwt.sign({ userId: id, organizationId: id, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const app = express();
    app.use(express.json());
    app.use("/api/v1/documents", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
    const text = [
      "NexaAI employee handbook. Employees receive eighteen days of paid annual leave.",
      "Leave requests should be submitted to a manager before the planned absence.",
      "Each organization has its own private document collection and knowledge base.",
    ].join("\n").repeat(10);
    const form = new FormData();
    form.append("document", new Blob([text], { type: "text/plain" }), "pipeline-handbook.txt");
    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(150000),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: body.document.id }, include: { chunks: { orderBy: { chunkIndex: "asc" } } },
    });
    assert.equal(document.organizationId, id);
    assert.equal(document.status, "COMPLETED");
    assert.equal(document.errorMessage, null);
    assert.equal(document.extractedText, text);
    assert.equal(document.originalName, "pipeline-handbook.txt");
    assert.ok(document.chunks.length > 1, "Test must exercise multiple chunks");
    document.chunks.forEach((chunk, index) => {
      assert.equal(chunk.chunkIndex, index);
      assert.equal(chunk.embeddingStatus, "COMPLETED");
      assert.ok(chunk.content.trim());
    });
    const storedFile = path.resolve(document.storagePath);
    assert.equal(path.dirname(storedFile), testDirectory);
    assert.equal(await fs.readFile(storedFile, "utf8"), text);
    const vectors = await prisma.$queryRaw`
      SELECT vector_dims(embedding) AS dimensions, embedding::text AS vector
      FROM "DocumentChunk" WHERE "documentId" = ${document.id}
    `;
    assert.equal(vectors.length, document.chunks.length);
    for (const row of vectors) {
      assert.equal(row.dimensions, 384);
      const vector = JSON.parse(row.vector);
      assert.equal(vector.length, 384);
      assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.001, "Embedding should be normalized");
    }
    const statusResponse = await fetch(`${baseUrl}/${document.id}/status`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).data.status, "COMPLETED");
    t.diagnostic(`Verified ${document.chunks.length} chunks, ${vectors.length} real vectors, 384 dimensions each.`);
    // The upload response must agree with the final persisted state.
    assert.equal(body.document.status, "COMPLETED");
    assert.equal(body.document.updatedAt, document.updatedAt.toISOString());
    assert.equal(body.document.errorMessage, null);
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (created) {
        await prisma.$transaction([
          prisma.document.deleteMany({ where: { organizationId: id } }),
          prisma.organization.delete({ where: { id } }),
          prisma.user.delete({ where: { id } }),
        ]);
      }
      // Only remove files directly inside this test's verified, unique tenant directory.
      const files = await fs.readdir(testDirectory).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const file of files) {
        const target = path.resolve(testDirectory, file);
        assert.equal(path.dirname(target), testDirectory);
        await fs.unlink(target);
      }
      await fs.rmdir(testDirectory).catch(error => { if (error.code !== "ENOENT") throw error; });
      t.diagnostic("Removed isolated test records and uploaded files.");
    } finally {
      if (originalSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalSecret;
      await prisma.$disconnect();
    }
  }
});
