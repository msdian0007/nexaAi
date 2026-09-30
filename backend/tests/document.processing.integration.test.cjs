// Requires a local test/development database and `npm run build` first.
// Database claims are real; extraction and AI work are replaced with controlled stubs.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const prisma = require("../dist/src/config/database").default;

let extract;
let chunkCalls;
let embeddingCalls;

function stubModule(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

stubModule("../dist/src/document/document.extractor", {
  extractTextFromDocument: (...args) => extract(...args),
});
stubModule("../dist/src/document/document.chunk.service", {
  createDocumentChunks: async () => { chunkCalls++; return []; },
});
stubModule("../dist/src/document/document.embedding.service", {
  embedDocumentChunks: async () => { embeddingCalls++; },
});

const { processDocument } = require("../dist/src/document/document.processing");

after(async () => { await prisma.$disconnect(); });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function withDocument(run) {
  const id = randomUUID();
  const document = await prisma.document.create({
    data: {
      name: "Processing concurrency test",
      originalName: "test.txt",
      mimeType: "text/plain",
      size: 4,
      storagePath: "unused-by-test-stub.txt",
      organization: { create: { id, name: "Processing test", slug: `processing-test-${id}` } },
      uploadedBy: { create: { id, name: "Processing test", email: `${id}@example.invalid`, password: "unused" } },
    },
  });

  chunkCalls = 0;
  embeddingCalls = 0;
  try {
    await run(document);
  } finally {
    // Only remove the uniquely identified records created by this test.
    await prisma.$transaction([
      prisma.document.delete({ where: { id: document.id } }),
      prisma.organization.delete({ where: { id } }),
      prisma.user.delete({ where: { id } }),
    ]);
  }
}

test("a second request cannot process an active document or change its status", async () => {
  await withDocument(async document => {
    const entered = deferred();
    const release = deferred();
    extract = async () => {
      entered.resolve();
      await release.promise;
      return "Document text";
    };

    const first = processDocument(document.id, document.organizationId);
    try {
      // Also propagate any failure before extraction, instead of waiting forever.
      await Promise.race([entered.promise, first]);
      await assert.rejects(processDocument(document.id, document.organizationId), /already being processed/);
      const active = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
      assert.equal(active.status, "PROCESSING");
      assert.equal(active.errorMessage, null);
      assert.equal(chunkCalls, 0);
      assert.equal(embeddingCalls, 0);
    } finally {
      release.resolve();
      await first;
    }

    const completed = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.extractedText, "Document text");
    assert.equal(chunkCalls, 1);
    assert.equal(embeddingCalls, 1);
  });
});

test("a processing failure records FAILED and permits a later retry", async () => {
  await withDocument(async document => {
    extract = async () => { throw new Error("Test extraction failure"); };
    await assert.rejects(processDocument(document.id, document.organizationId), /Test extraction failure/);
    const failed = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.errorMessage, "Test extraction failure");
    assert.equal(chunkCalls, 0);
    assert.equal(embeddingCalls, 0);

    extract = async () => "Recovered document text";
    await processDocument(document.id, document.organizationId);
    const recovered = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    assert.equal(recovered.status, "COMPLETED");
    assert.equal(recovered.errorMessage, null);
    assert.equal(chunkCalls, 1);
    assert.equal(embeddingCalls, 1);
  });
});

test("a missing document is rejected", async () => {
  await assert.rejects(processDocument(randomUUID(), randomUUID()), /Document not found/);
});
