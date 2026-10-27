import prisma from "../config/database";
import { audit } from "../observability/audit";
import type { Prisma } from "../../generated/prisma/client";
import { getDocumentQueue, QueueProvider } from "./document.queue.runtime";
import { deleteStoredDocument, validateDocumentStoragePath } from "./document.storage";

export class DocumentDeletionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function requireProcessingMembership(userId: string, organizationId: string) {
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId, organizationId } }, select: { id: true },
  });
  if (!membership) throw new DocumentDeletionError(403, "Current organization membership is required");
}
export async function withDocumentSubmissionLock<T>(documentId: string, organizationId: string, action: () => Promise<T>, userId?: string) {
  return prisma.$transaction(async tx => {
    if (userId) {
      // Match membership removal's organization lock, then recheck before the
      // queue write. An old token cannot restore a removed membership.
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
      const membership = await tx.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId } }, select: { id: true },
      });
      if (!membership) throw new DocumentDeletionError(403, "Current organization membership is required");
    }
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${documentId}, 0)) AS acquired`;
    if (!lock?.acquired) throw new DocumentDeletionError(409, "Document state is changing");
    const document = await tx.document.findFirst({ where: { id: documentId, organizationId, deletionRequestedAt: null }, select: { id: true, status: true } });
    if (!document || document.status === "COMPLETED") throw new DocumentDeletionError(409, "Document is unavailable for processing");
    // Submission and deletion share a lock, so an earlier status read cannot
    // enqueue work after deletion finishes.
    return action();
  }, { timeout: 30000 });
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
    try { validateDocumentStoragePath(document.storagePath, organizationId); }
    catch { throw new DocumentDeletionError(409, "Document storage location requires repair"); }
    await tx.document.update({ where: { id: documentId }, data: {
      deletionRequestedAt: document.deletionRequestedAt ?? new Date(), extractedText: null, errorMessage: null,
    } });
    await tx.documentChunk.deleteMany({ where: { documentId } });
    if (!document.deletionRequestedAt) await audit(tx, organizationId, userId, "DOCUMENT_DELETION_REQUESTED", documentId);
  }, { timeout: 15000 });
  try {
    return await prisma.$transaction(async tx => {
      const document = await lockedDocument(tx, organizationId, userId, documentId);
      const queue = await queueProvider();
      if (!await queue.removeIfIdle({ documentId, organizationId }))
        return { documentId, organizationId, deleted: false, cleanupPending: true };
      await deleteStoredDocument(document.storagePath, organizationId);
      // Citation snapshots have no document foreign key, so past answers survive.
      await tx.document.delete({ where: { id: documentId } });
      await audit(tx, organizationId, userId, "DOCUMENT_DELETED", documentId);
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
