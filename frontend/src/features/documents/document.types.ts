export interface DocumentStatus {
  id: string;
  originalName: string;
  status: "UPLOADED" | "PROCESSING" | "COMPLETED" | "FAILED";
  updatedAt: string;
  errorMessage: string | null;
  processingState?:
    | "QUEUED"
    | "PROCESSING"
    | "RETRYING"
    | "READY"
    | "FAILED"
    | "NOT_QUEUED"
    | "DELETING"
    | "UNAVAILABLE";
  canRetry?: boolean;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_ACCEPT =
  ".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";

export function validateFile(file: File): string | null {
  if (!/\.(pdf|docx|txt)$/i.test(file.name))
    return "Choose a PDF, DOCX, or TXT file.";
  if (file.size === 0)
    return "This file is empty. Choose a file containing text.";
  if (file.size > MAX_UPLOAD_BYTES)
    return "The file must be 10 MiB or smaller.";
  if (
    file.type &&
    ![
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ].includes(file.type)
  ) {
    return "This file type is not supported. Choose a PDF, DOCX, or TXT file.";
  }
  return null;
}

export function parseDocument(value: unknown): DocumentStatus {
  const doc = value as DocumentStatus | null;
  if (
    !doc ||
    typeof doc.id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(doc.id) ||
    typeof doc.originalName !== "string" ||
    !["UPLOADED", "PROCESSING", "COMPLETED", "FAILED"].includes(doc.status) ||
    typeof doc.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(doc.updatedAt))
  ) {
    throw new Error("Invalid document response");
  }
  if (
    (doc.processingState !== undefined &&
      ![
        "QUEUED",
        "PROCESSING",
        "RETRYING",
        "READY",
        "FAILED",
        "NOT_QUEUED",
        "DELETING",
        "UNAVAILABLE",
      ].includes(doc.processingState)) ||
    (doc.canRetry !== undefined && typeof doc.canRetry !== "boolean")
  )
    throw new Error("Invalid processing status");
  return doc;
}

export function processingState(doc: DocumentStatus) {
  // Preserve compatibility with older status responses while deployments roll out.
  return (
    doc.processingState ??
    (
      {
        UPLOADED: "QUEUED",
        PROCESSING: "PROCESSING",
        COMPLETED: "READY",
        FAILED: "FAILED",
      } as const
    )[doc.status]
  );
}

export const PROCESSING_LABELS = {
  QUEUED: "Waiting for processing",
  PROCESSING: "Processing",
  READY: "Ready for questions",
  FAILED: "Processing failed",
  RETRYING: "Retrying automatically",
  NOT_QUEUED: "Saved — processing not queued",
  DELETING: "Deletion pending — blocked from questions",
  UNAVAILABLE: "Processing status temporarily unavailable",
};
export interface LibraryDocument extends DocumentStatus {
  organizationId: string;
  createdAt: string;
  mimeType: string;
  size: number;
}
export function parseDocumentLibrary(value: unknown, organizationId: string) {
  const data = value as {
    organizationId: string;
    canDelete?: boolean;
    documents: unknown[];
    page: { limit: number; hasMore: boolean; nextCursor: string | null };
  } | null;
  if (
    !data ||
    data.organizationId !== organizationId ||
    (data.canDelete !== undefined && typeof data.canDelete !== "boolean") ||
    !Array.isArray(data.documents) ||
    !data.page ||
    !Number.isInteger(data.page.limit) ||
    data.page.limit < 1 ||
    data.page.limit > 50 ||
    data.documents.length > data.page.limit ||
    typeof data.page.hasMore !== "boolean" ||
    (data.page.hasMore
      ? typeof data.page.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(data.page.nextCursor)
      : data.page.nextCursor !== null)
  )
    throw new Error("Invalid document library response");
  const documents = data.documents.map((value) => {
    const item = parseDocument(value) as LibraryDocument;
    if (
      item.organizationId !== organizationId ||
      typeof item.createdAt !== "string" ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.mimeType !== "string" ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.processingState === undefined ||
      typeof item.canRetry !== "boolean"
    )
      throw new Error("Invalid document metadata");
    return item;
  });
  if (
    new Set(documents.map((item) => item.id)).size !== documents.length ||
    (data.page.hasMore && !documents.length)
  )
    throw new Error("Invalid document page");
  return { documents, canDelete: data.canDelete === true, page: data.page };
}
