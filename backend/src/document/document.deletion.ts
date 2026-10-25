import fs from "node:fs/promises";
import path from "node:path";
import prisma from "../config/database";
import type { Prisma } from "../../generated/prisma/client";
import { getDocumentQueue, QueueProvider } from "./document.queue.runtime";

export class DocumentDeletionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function withDocumentSubmissionLock<T>(documentId: string, organizationId: string, action: () => Promise<T>) {
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${documentId}, 0)) AS acquired`;
    if (!lock?.acquired) throw new DocumentDeletionError(409, "Document state is changing");
    const document = await tx.document.findFirst({ where: { id: documentId, organizationId, deletionRequestedAt: null }, select: { id: true } });
    if (!document) throw new DocumentDeletionError(409, "Document is unavailable for processing");
    // Submission and deletion share a lock, so an earlier status read cannot
    // enqueue work after deletion finishes.
    return action();
  }, { timeout: 30000 });
}
function fileTarget(storagePath: string, organizationId: string) {
  const root = path.resolve("uploads", "documents", organizationId);
  const target = path.resolve(storagePath);
  // Uploaded files must be direct children of their tenant folder. No traversal,
  // directory target or foreign path can reach unlink below.
  if (path.dirname(target) !== root || path.basename(target) === "." || path.basename(target) === "..")
    throw new DocumentDeletionError(409, "Document storage location requires repair");
  return { root, target };
}
async function unlinkDocumentFile(storagePath: string, organizationId: string) {
  const { root, target } = fileTarget(storagePath, organizationId);
  // Reject symlinks/junctions in every upload directory; delete only one exact
  // regular file, never a directory or recursive path.
  for (const directory of [path.resolve("uploads"), path.resolve("uploads", "documents"), root]) {
    try {
      const info = await fs.lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsafe upload directory");
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
    // Missing files are already cleaned, including after a crash between unlink
    // and the final database commit. Finish deletion can safely resume.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function lockedDocument(tx: Prisma.TransactionClient, organizationId: string, userId: string, documentId: string) {
  // Match role/member changes and the worker's advisory lock. The role read is
  // current, and we refuse deletion while a processing transaction owns the file.
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
  const member = await tx.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId } }, select: { role: true },
  });
  if (!member || (member.role !== "OWNER" && member.role !== "ADMIN"))
    throw new DocumentDeletionError(403, "Only a current owner or administrator can delete documents");
  const document = await tx.document.findFirst({ where: { id: documentId, organizationId } });
  if (!document) throw new DocumentDeletionError(404, "Document not found");
  const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${documentId}, 0)) AS acquired`;
  if (!lock?.acquired) throw new DocumentDeletionError(409, "Document is being processed; wait and try again");
  return document;
}
export async function deleteOrganizationDocument(
  organizationId: string, userId: string, documentId: string,
  queueProvider: QueueProvider = getDocumentQueue,
) {
  // Commit durable intent and remove retrieval data BEFORE external cleanup.
  // PostgreSQL, Redis and the filesystem cannot share one atomic transaction.
  await prisma.$transaction(async tx => {
    const document = await lockedDocument(tx, organizationId, userId, documentId);
    fileTarget(document.storagePath, organizationId);
    await tx.document.update({ where: { id: documentId }, data: {
      deletionRequestedAt: document.deletionRequestedAt ?? new Date(), extractedText: null, errorMessage: null,
    } });
    await tx.documentChunk.deleteMany({ where: { documentId } });
  }, { timeout: 15000 });
  try {
    return await prisma.$transaction(async tx => {
      const document = await lockedDocument(tx, organizationId, userId, documentId);
      const queue = await queueProvider();
      if (!await queue.removeIfIdle({ documentId, organizationId }))
        return { documentId, organizationId, deleted: false, cleanupPending: true };
      await unlinkDocumentFile(document.storagePath, organizationId);
      // Citation snapshots have no document foreign key, so past answers survive.
      await tx.document.delete({ where: { id: documentId } });
      return { documentId, organizationId, deleted: true, cleanupPending: false };
    }, { timeout: 30000 });
  } catch (error) {
    if (error instanceof DocumentDeletionError) {
      if (error.status === 404) return { documentId, organizationId, deleted: true, cleanupPending: false };
      throw error;
    }
    return { documentId, organizationId, deleted: false, cleanupPending: true };
  }
}
