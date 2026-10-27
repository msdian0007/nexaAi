const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  deleteStoredDocument,
  documentStorageConfig,
  putStoredDocument,
  storagePathFor,
  validateDocumentStoragePath,
  withStoredDocumentFile,
} = require("../dist/src/document/document.storage");

test("local storage writes, reads and idempotently deletes one tenant object", async () => {
  const organizationId = randomUUID();
  const documentId = randomUUID();
  const config = { driver: "local" };
  const storagePath = storagePathFor(organizationId, documentId, "handbook.txt", config);
  const root = path.resolve("uploads", "documents", organizationId);
  const bytes = Buffer.from("Fictional handbook text.");
  try {
    await putStoredDocument(storagePath, organizationId, documentId, "text/plain", bytes, config);
    const text = await withStoredDocumentFile(storagePath, organizationId, file => fs.readFile(file, "utf8"), config);
    assert.equal(text, bytes.toString());
    await assert.rejects(
      putStoredDocument(storagePath, organizationId, documentId, "text/plain", bytes, config),
      error => error.code === "EEXIST",
    );
    await deleteStoredDocument(storagePath, organizationId, config);
    await deleteStoredDocument(storagePath, organizationId, config);
    await assert.rejects(fs.stat(path.resolve(storagePath)), { code: "ENOENT" });
  } finally {
    assert.equal(path.dirname(root), path.resolve("uploads", "documents"));
    await fs.unlink(path.resolve(storagePath)).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.rmdir(root).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
});

test("storage references cannot cross an organization boundary", () => {
  const owner = randomUUID();
  const other = randomUUID();
  const id = randomUUID();
  assert.throws(() => validateDocumentStoragePath(`documents/${owner}/${id}.pdf`, other, { driver: "s3" }));
  assert.throws(() => validateDocumentStoragePath("../outside.txt", owner, { driver: "local" }));
});

test("S3 production configuration requires a private HTTPS-compatible endpoint and credentials", () => {
  const valid = {
    DOCUMENT_STORAGE_DRIVER: "s3",
    S3_ENDPOINT: "https://account.example-storage.test",
    S3_REGION: "auto",
    S3_BUCKET: "nexaai-private-documents",
    S3_ACCESS_KEY_ID: "synthetic-access-key",
    S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  };
  assert.deepEqual(documentStorageConfig(valid), {
    driver: "s3",
    endpoint: valid.S3_ENDPOINT,
    region: "auto",
    bucket: valid.S3_BUCKET,
    accessKeyId: valid.S3_ACCESS_KEY_ID,
    secretAccessKey: valid.S3_SECRET_ACCESS_KEY,
    forcePathStyle: false,
  });
  assert.throws(() => documentStorageConfig({ ...valid, S3_ENDPOINT: "http://storage.test" }));
  assert.throws(() => documentStorageConfig({ ...valid, S3_SECRET_ACCESS_KEY: "replace-me" }));
  assert.throws(() => documentStorageConfig({ ...valid, S3_FORCE_PATH_STYLE: "yes" }));
  assert.throws(() => documentStorageConfig({ DOCUMENT_STORAGE_DRIVER: "unknown" }));
});
