import prisma from "../config/database";
import { createDocumentChunks } from "./document.chunk.service";
import { embedDocumentChunks } from "./document.embedding.service";
import { extractTextFromDocument } from "./document.extractor";
import {
  DocumentNotFoundError,
  DocumentProcessingConflictError,
} from "./document.errors";

// BullMQ can stop retrying a repeatedly crashed job without calling the processor.
// Reconcile its visible status only if no live processing transaction owns it.
export const markInterruptedDocumentFailed = async (
  documentId: string,
  organizationId: string,
) =>
  prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${documentId}, 0)) AS acquired`;
    if (!lock?.acquired) return;
    await tx.document.updateMany({
      where: { id: documentId, organizationId, status: "PROCESSING", deletionRequestedAt: null },
      data: {
        status: "FAILED",
        errorMessage:
          "Document processing was interrupted. Retry the document.",
      },
    });
  });

export const processDocument = async (
  documentId: string,
  organizationId: string,
  { retryFailedOnly = false }: { retryFailedOnly?: boolean } = {},
) => {
  if (!organizationId?.trim()) throw new DocumentNotFoundError();

  const outcome = await prisma.$transaction(
    async (tx) => {
      // PostgreSQL releases this permission on commit, rollback or connection loss.
      // A PROCESSING label alone cannot tell us whether an earlier worker is alive.
      // Hash collisions only serialize unrelated documents; they cannot mix data.
      const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${documentId}, 0)) AS acquired`;
      const document = await tx.document.findFirst({
        where: { id: documentId, organizationId, deletionRequestedAt: null },
      });
      if (!document) throw new DocumentNotFoundError();
      if (!lock?.acquired)
        throw new DocumentProcessingConflictError(
          "Document is already being processed",
        );
      if (retryFailedOnly && document.status !== "FAILED") {
        throw new DocumentProcessingConflictError(
          "Only failed documents can be reprocessed",
        );
      }
      // Redis can redeliver after a database commit but before acknowledgement.
      // Preserve successful chunks and their IDs instead of rebuilding them.
      if (document.status === "COMPLETED") {
        return {
          result: {
            documentId,
            status: "COMPLETED",
            textLength: document.extractedText?.length ?? 0,
          },
        };
      }

      // Publish visible progress on another connection while holding our lock.
      // All processing entry points must follow this same locking protocol.
      await prisma.document.update({
        where: { id: documentId },
        data: { status: "PROCESSING", errorMessage: null },
      });
      await tx.$executeRaw`SAVEPOINT document_work`;
      try {
        const extractedText = await extractTextFromDocument(
          document.storagePath,
          document.mimeType,
        );
        if (!extractedText.trim())
          throw new Error("No text could be extracted from the document");
        // All result writes share this transaction. An old attempt whose connection
        // dies cannot resume writing through a fresh connection after lock loss.
        await createDocumentChunks(document.id, extractedText, tx);
        await embedDocumentChunks(document.id, tx);
        await tx.document.update({
          where: { id: documentId },
          data: { extractedText, status: "COMPLETED", errorMessage: null },
        });
        return {
          result: {
            documentId,
            status: "COMPLETED",
            textLength: extractedText.length,
          },
        };
      } catch (error) {
        // Undo partial chunks but keep the lock while recording failure. Writing
        // FAILED after releasing the lock could overwrite a newer attempt's result.
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT document_work`;
        await tx.document.update({
          where: { id: documentId },
          data: {
            status: "FAILED",
            // Persist a safe category, not arbitrary parser/model/DB messages.
            // BullMQ and the HTTP document view already sanitize their receipts.
            errorMessage: "Document processing failed.",
          },
        });
        return { error };
      }
    },
    { timeout: 180000, maxWait: 10000 },
  );
  // Commit FAILED before throwing. A crash/transaction timeout rolls back work;
  // a later attempt can safely reclaim the remaining PROCESSING label.
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
};
