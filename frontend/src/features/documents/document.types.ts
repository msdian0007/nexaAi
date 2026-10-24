export interface DocumentStatus {
  id: string;
  originalName: string;
  status: 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  updatedAt: string;
  errorMessage: string | null;
  processingState?: 'QUEUED' | 'PROCESSING' | 'RETRYING' | 'READY' | 'FAILED' | 'NOT_QUEUED' | 'UNAVAILABLE';
  canRetry?: boolean;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_ACCEPT = '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

export function validateFile(file: File): string | null {
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) return 'Choose a PDF, DOCX, or TXT file.';
  if (file.size === 0) return 'This file is empty. Choose a file containing text.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file must be 10 MiB or smaller.';
  if (file.type && !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'].includes(file.type)) {
    return 'This file type is not supported. Choose a PDF, DOCX, or TXT file.';
  }
  return null;
}

export function parseDocument(value: unknown): DocumentStatus {
  const doc = value as DocumentStatus | null;
  if (!doc || typeof doc.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(doc.id) ||
      typeof doc.originalName !== 'string' || !['UPLOADED', 'PROCESSING', 'COMPLETED', 'FAILED'].includes(doc.status) ||
      typeof doc.updatedAt !== 'string' || !Number.isFinite(Date.parse(doc.updatedAt))) {
    throw new Error('Invalid document response');
  }
  if ((doc.processingState !== undefined && !['QUEUED', 'PROCESSING', 'RETRYING', 'READY', 'FAILED', 'NOT_QUEUED', 'UNAVAILABLE'].includes(doc.processingState)) ||
      (doc.canRetry !== undefined && typeof doc.canRetry !== 'boolean')) throw new Error('Invalid processing status');
  return doc;
}

export function processingState(doc: DocumentStatus) {
  // Preserve compatibility with older status responses while deployments roll out.
  return doc.processingState ?? ({ UPLOADED: 'QUEUED', PROCESSING: 'PROCESSING', COMPLETED: 'READY', FAILED: 'FAILED' } as const)[doc.status];
}
