// Run after `npm run build`, against a local test/development database.
// Uses the real router, JWT middleware, and PostgreSQL; only processing is stubbed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const express = require("express");
const jwt = require("jsonwebtoken");
const prisma = require("../dist/src/config/database").default;

// Status requests must never start extraction, chunking, or model loading.
const processingPath = require.resolve("../dist/src/document/document.processing");
require.cache[processingPath] = {
  id: processingPath,
  filename: processingPath,
  loaded: true,
  exports: { processDocument: async () => { throw new Error("Unexpected document processing"); } },
};
const router = require("../dist/src/document/document.routes").default;

let server;
let baseUrl;
let document;
let token;
const ownerId = randomUUID();
const originalSecret = process.env.JWT_SECRET;

before(async () => {
  process.env.JWT_SECRET = randomUUID();
  document = await prisma.document.create({
    data: {
      name: "internal-storage-name.txt",
      originalName: "Employee handbook.txt",
      mimeType: "text/plain",
      size: 4,
      storagePath: "private/internal/path.txt",
      extractedText: "Private document content",
      organization: { create: { id: ownerId, name: "Status test", slug: `status-test-${ownerId}` } },
      uploadedBy: { create: { id: ownerId, name: "Status test", email: `${ownerId}@example.invalid`, password: "unused" } },
    },
  });
  token = jwt.sign({ userId: ownerId, organizationId: ownerId, role: "MEMBER" }, process.env.JWT_SECRET, { expiresIn: "5m" });
  const app = express();
  app.use("/api/v1/documents", router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
});

after(async () => {
  try {
    if (server) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (document) {
      await prisma.$transaction([
        prisma.document.delete({ where: { id: document.id } }),
        prisma.organization.delete({ where: { id: ownerId } }),
        prisma.user.delete({ where: { id: ownerId } }),
      ]);
    }
  } finally {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    await prisma.$disconnect();
  }
});

async function getStatus(id, authorization = token, query = "") {
  const response = await fetch(`${baseUrl}/${encodeURIComponent(id)}/status${query}`, {
    headers: authorization ? { Authorization: `Bearer ${authorization}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

test("returns all processing states for a member of the document's organization", async () => {
  for (const status of ["UPLOADED", "PROCESSING", "COMPLETED", "FAILED"]) {
    const updated = await prisma.document.update({
      where: { id: document.id },
      data: { status, errorMessage: status === "FAILED" ? "Internal database exception at private/path" : null },
    });
    const response = await getStatus(document.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      success: true,
      data: {
        id: document.id,
        originalName: "Employee handbook.txt",
        status,
        updatedAt: updated.updatedAt.toISOString(),
        errorMessage: status === "FAILED" ? "Document processing failed." : null,
      },
    });
    // Reading status must not change the record.
    const afterRead = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(afterRead.updatedAt.toISOString(), updated.updatedAt.toISOString());
    assert.equal(afterRead.status, status);
  }
});

test("another tenant sees the same 404 as a missing document, even with an organization query override", async () => {
  const otherTenantToken = jwt.sign({ userId: randomUUID(), organizationId: randomUUID(), role: "OWNER" }, process.env.JWT_SECRET);
  const inaccessible = await getStatus(document.id, otherTenantToken, `?organizationId=${ownerId}`);
  const missing = await getStatus(randomUUID());
  assert.equal(inaccessible.status, 404);
  assert.deepEqual(inaccessible, missing);
  assert.deepEqual(missing.body, { success: false, message: "Document not found" });
});

test("rejects absent, invalid, and expired tokens", async () => {
  const expired = jwt.sign({ userId: ownerId, organizationId: ownerId }, process.env.JWT_SECRET, { expiresIn: -1 });
  for (const authorization of [null, "invalid-token", expired]) {
    const response = await getStatus(document.id, authorization);
    assert.equal(response.status, 401);
    assert.equal(response.body.success, false);
    assert.equal(response.body.data, undefined);
  }
});

test("rejects a signed token without an organization instead of making an unscoped query", async () => {
  const missingContext = jwt.sign({ userId: ownerId, role: "MEMBER" }, process.env.JWT_SECRET);
  const response = await getStatus(document.id, missingContext);
  assert.equal(response.status, 401);
  assert.equal(response.body.message, "Organization context is missing");
});

test("rejects a blank document ID", async () => {
  const response = await getStatus(" ");
  assert.equal(response.status, 400);
});
