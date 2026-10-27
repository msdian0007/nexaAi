import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type DocumentStorageDriver = "local" | "s3";

export interface DocumentStorageConfig {
  driver: DocumentStorageDriver;
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

const DOCUMENT_ROOT = path.resolve("uploads", "documents");
const MAX_STORED_BYTES = 10 * 1024 * 1024;
const OBJECT_KEY = /^documents\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(txt|pdf|docx)$/;
const LOCAL_NAME = /^[0-9a-f-]{36}\.(txt|pdf|docx)$/;

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value || /replace|changeme/i.test(value))
    throw new Error(`Required storage setting ${name} is missing.`);
  return value;
}

// Local storage keeps development simple. Production uses the same private
// S3-compatible contract with Cloudflare R2, AWS S3, MinIO, or another provider.
export function documentStorageConfig(env: NodeJS.ProcessEnv = process.env): DocumentStorageConfig {
  const driver = (env.DOCUMENT_STORAGE_DRIVER?.trim() || "local").toLowerCase();
  if (driver === "local") return { driver };
  if (driver !== "s3") throw new Error("DOCUMENT_STORAGE_DRIVER must be local or s3.");
  const endpoint = required(env, "S3_ENDPOINT");
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error();
  } catch { throw new Error("S3_ENDPOINT must be a credential-free HTTPS URL."); }
  const bucket = required(env, "S3_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error("S3_BUCKET must be a valid private bucket name.");
  const forcePathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  if (forcePathStyle && !["true", "false"].includes(forcePathStyle))
    throw new Error("S3_FORCE_PATH_STYLE must be true or false.");
  return {
    driver,
    endpoint,
    bucket,
    region: required(env, "S3_REGION"),
    accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: forcePathStyle === "true",
  };
}

function extension(value: string) {
  const result = path.extname(value).toLowerCase();
  if (![".txt", ".pdf", ".docx"].includes(result)) throw new Error("Unsupported document extension");
  return result;
}

export function storagePathFor(
  organizationId: string,
  documentId: string,
  originalName: string,
  config = documentStorageConfig(),
) {
  const name = `${documentId}${extension(originalName)}`;
  return config.driver === "s3"
    ? `documents/${organizationId}/${name}`
    : path.relative(process.cwd(), path.join(DOCUMENT_ROOT, organizationId, name));
}

function localTarget(storagePath: string, organizationId: string) {
  const root = path.join(DOCUMENT_ROOT, organizationId);
  const target = path.resolve(storagePath);
  if (path.dirname(target) !== root || !LOCAL_NAME.test(path.basename(target)))
    throw new Error("Document storage location requires repair");
  return { root, target };
}

function objectKey(storagePath: string, organizationId: string) {
  const match = OBJECT_KEY.exec(storagePath);
  if (!match || match[1] !== organizationId)
    throw new Error("Document storage location requires repair");
  return storagePath;
}

export function validateDocumentStoragePath(
  storagePath: string,
  organizationId: string,
  config = documentStorageConfig(),
) {
  if (config.driver === "s3") objectKey(storagePath, organizationId);
  else localTarget(storagePath, organizationId);
}

let cachedS3: { identity: string; client: S3Client } | undefined;
function s3Client(config: DocumentStorageConfig) {
  // Reuse the HTTP connection pool across requests/jobs. The identity excludes
  // the secret itself while still replacing the client when deployment settings change.
  const identity = [config.endpoint, config.region, config.bucket, config.accessKeyId, config.forcePathStyle].join("|");
  if (cachedS3?.identity === identity) return cachedS3.client;
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId!,
      secretAccessKey: config.secretAccessKey!,
    },
  });
  cachedS3 = { identity, client };
  return client;
}

export async function putStoredDocument(
  storagePath: string,
  organizationId: string,
  documentId: string,
  contentType: string,
  bytes: Buffer,
  config = documentStorageConfig(),
) {
  if (bytes.length > MAX_STORED_BYTES) throw new Error("Document exceeds storage limit");
  validateDocumentStoragePath(storagePath, organizationId, config);
  if (config.driver === "s3") {
    await s3Client(config).send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: storagePath,
      Body: bytes,
      ContentType: contentType,
      Metadata: { organization: organizationId, document: documentId },
    }));
    return;
  }
  const { root, target } = localTarget(storagePath, organizationId);
  await fs.mkdir(root, { recursive: true });
  for (const directory of [DOCUMENT_ROOT, root]) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe upload directory");
  }
  // wx prevents a generated identifier from silently replacing existing bytes.
  await fs.writeFile(target, bytes, { flag: "wx" });
}

export async function deleteStoredDocument(
  storagePath: string,
  organizationId: string,
  config = documentStorageConfig(),
) {
  validateDocumentStoragePath(storagePath, organizationId, config);
  if (config.driver === "s3") {
    await s3Client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: storagePath }));
    return;
  }
  const { root, target } = localTarget(storagePath, organizationId);
  for (const directory of [DOCUMENT_ROOT, root]) {
    try {
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe upload directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  try {
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe document file");
    await fs.unlink(target);
  } catch (error) {
    // Deletion is idempotent so a crashed cleanup can be safely resumed.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function withStoredDocumentFile<T>(
  storagePath: string,
  organizationId: string,
  action: (filePath: string) => Promise<T>,
  config = documentStorageConfig(),
) {
  validateDocumentStoragePath(storagePath, organizationId, config);
  if (config.driver === "local") return action(localTarget(storagePath, organizationId).target);

  const response = await s3Client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: storagePath }));
  if (!response.Body || (response.ContentLength ?? 0) > MAX_STORED_BYTES)
    throw new Error("Stored document is unavailable or too large");
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (bytes.length > MAX_STORED_BYTES) throw new Error("Stored document exceeds storage limit");
  const temporaryRoot = path.join(os.tmpdir(), "nexaai-documents");
  const temporaryPath = path.join(temporaryRoot, `${randomUUID()}${extension(storagePath)}`);
  await fs.mkdir(temporaryRoot, { recursive: true });
  await fs.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  try { return await action(temporaryPath); }
  finally { await fs.unlink(temporaryPath).catch(() => undefined); }
}

export async function checkDocumentStorage(config = documentStorageConfig()) {
  if (config.driver === "s3") {
    await s3Client(config).send(new HeadBucketCommand({ Bucket: config.bucket }));
    return true;
  }
  await fs.mkdir(DOCUMENT_ROOT, { recursive: true });
  const info = await fs.lstat(DOCUMENT_ROOT);
  return info.isDirectory() && !info.isSymbolicLink();
}
