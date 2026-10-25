import prisma from "../config/database";
import { getDocumentQueue, QueueProvider } from "./document.queue.runtime";

export type ProcessingState =
  | "QUEUED"
  | "PROCESSING"
  | "RETRYING"
  | "READY"
  | "FAILED"
  | "NOT_QUEUED"
  | "DELETING"
  | "UNAVAILABLE";

// Only these fields are exposed to the browser, including on a saved-but-not-queued error.
export function documentView(
  document: {
    id: string;
    originalName: string;
    status: string;
    updatedAt: Date;
  },
  processingState: ProcessingState,
) {
  return {
    id: document.id,
    originalName: document.originalName,
    status: document.status,
    updatedAt: document.updatedAt,
    processingState,
    canRetry: processingState === "FAILED" || processingState === "NOT_QUEUED",
    errorMessage:
      processingState === "FAILED" ? "Document processing failed." : null,
  };
}

export const getDocumentStatus = async (
  documentId: string,
  organizationId: string,
  queueProvider: QueueProvider = getDocumentQueue,
) => {
  const document = await prisma.document.findFirst({
    where: { id: documentId, organizationId },
    select: { id: true, originalName: true, status: true, updatedAt: true, deletionRequestedAt: true },
  });
  if (!document) return null;
  return resolveDocumentStatus(document, organizationId, queueProvider);
};

// Share the database/queue interpretation between a single status read and the
// library, without making another database query for every listed document.
export async function resolveDocumentStatus(
  document: {
    id: string;
    originalName: string;
    status: string;
    updatedAt: Date;
    deletionRequestedAt?: Date | null;
  },
  organizationId: string,
  queueProvider: QueueProvider,
) {
  if (document.deletionRequestedAt) return documentView(document, "DELETING");
  // The committed database result wins, even when Redis is down or removed its history.
  if (document.status === "COMPLETED") return documentView(document, "READY");
  try {
    const queue = await queueProvider();
    const state = await queue.getState({
      documentId: document.id,
      organizationId,
    });
    const states: Record<string, ProcessingState> = {
      waiting: "QUEUED",
      "waiting-children": "QUEUED",
      prioritized: "QUEUED",
      active: "PROCESSING",
      delayed: "RETRYING",
      failed: "FAILED",
      unknown: "NOT_QUEUED",
    };
    // A database failure may be temporary: a delayed Redis job is still retrying.
    // An inconsistent completed job with no committed document is not falsely Ready.
    return documentView(document, states[state] ?? "UNAVAILABLE");
  } catch {
    return documentView(document, "UNAVAILABLE");
  }
}

interface CreateDocumentInput {
  organizationId: string;
  uploadedById: string;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  storagePath: string;
}

export const createDocument = async (data: CreateDocumentInput) => {
  return prisma.document.create({
    data: {
      organizationId: data.organizationId,
      uploadedById: data.uploadedById,
      name: data.name,
      originalName: data.originalName,
      mimeType: data.mimeType,
      size: data.size,
      storagePath: data.storagePath,
    },
  });
};
