import prisma from "../config/database";
import { createDocumentChunks } from "./document.chunk.service";
import { embedDocumentChunks } from "./document.embedding.service";
import { extractTextFromDocument } from "./document.extractor";
import { DocumentNotFoundError, DocumentProcessingConflictError } from "./document.errors";

export const processDocument = async (
  documentId: string,
  organizationId: string,
  { retryFailedOnly = false }: { retryFailedOnly?: boolean } = {},
) => {
  if (!organizationId?.trim()) {
    throw new DocumentNotFoundError();
  }

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      organizationId,
    },
  });

  if (!document) {
    throw new DocumentNotFoundError();
  }

  // Claim the document atomically so concurrent requests cannot both process it.
  const claim = await prisma.document.updateMany({
    where: {
      id: documentId,
      organizationId,
      status: retryFailedOnly ? "FAILED" : { not: "PROCESSING" },
    },
    data: {
      status: "PROCESSING",
      errorMessage: null,
    },
  });

  // Keep this outside the catch: a rejected request must not mark the active job FAILED.
  if (claim.count === 0) {
    throw new DocumentProcessingConflictError(
      retryFailedOnly
        ? "Only failed documents can be reprocessed"
        : "Document is already being processed",
    );
  }

  try {
    const extractedText = await extractTextFromDocument(
      document.storagePath,
      document.mimeType,
    );

    if (!extractedText.trim()) {
      throw new Error("No text could be extracted from the document");
    }

    await createDocumentChunks(document.id, extractedText);

    await embedDocumentChunks(document.id);

    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        extractedText,
        status: "COMPLETED",
      },
    });

    return {
      documentId,
      status: "COMPLETED",
      textLength: extractedText.length,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Document processing failed";

    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        status: "FAILED",
        errorMessage: message,
      },
    });

    throw error;
  }
};
