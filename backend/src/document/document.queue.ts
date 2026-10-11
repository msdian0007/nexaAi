import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';

export const DOCUMENT_QUEUE_NAME = 'nexaai-document-processing';
export const DOCUMENT_JOB_NAME = 'process-document';
export type DocumentJobData = { documentId: string; organizationId: string };

export class DocumentQueueUnavailableError extends Error {
  constructor() { super('Document processing queue is unavailable.'); }
}

// Runtime validation is needed even with TypeScript: jobs can come from JavaScript
// callers today and persisted Redis data later. Copy only the fields the worker needs.
export function parseDocumentJobData(value: unknown): DocumentJobData {
  const data = value as Partial<DocumentJobData> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!data || typeof data.documentId !== 'string' || !uuid.test(data.documentId) ||
      typeof data.organizationId !== 'string' || !uuid.test(data.organizationId)) {
    throw new Error('Document jobs require valid document and organization UUIDs.');
  }
  return { documentId: data.documentId, organizationId: data.organizationId };
}

// Bound readiness as well as individual commands. A silent Redis server must not
// keep the future upload request waiting indefinitely.
async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DocumentQueueUnavailableError()), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

// Explicit startup keeps imports side-effect free. Create one producer at application
// startup and close it on shutdown; do not open a Redis connection for every upload.
// queueName is server configuration (also used to isolate tests), never request input.
export async function createDocumentQueue(options: { url?: string; queueName?: string } = {}) {
  const name = options.queueName ?? DOCUMENT_QUEUE_NAME;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid document queue name.');
  const connection = createRedisConnection(options.url);
  let queue: Queue<DocumentJobData, void, typeof DOCUMENT_JOB_NAME> | undefined;
  try {
    await withDeadline(connection.connect());
    queue = new Queue<DocumentJobData, void, typeof DOCUMENT_JOB_NAME>(name, {
      connection,
      skipWaitingForReady: true,
      defaultJobOptions: {
        // Retries require a worker with safe recovery semantics; add those together
        // in the worker step. Keep terminal jobs so IDs remain deduplicated for now.
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
    // BullMQ emits connection errors separately from rejected commands. Log only
    // a fixed message so URLs, credentials and job contents cannot enter logs.
    queue.on('error', () => console.error('Document queue connection error.'));
    await withDeadline(queue.waitUntilReady());
  } catch {
    connection.disconnect();
    await queue?.close();
    throw new DocumentQueueUnavailableError();
  }
  const readyQueue = queue;
  let closed = false;
  return {
    async enqueue(value: unknown): Promise<{ jobId: string }> {
      const data = parseDocumentJobData(value);
      if (closed || connection.status !== 'ready') throw new DocumentQueueUnavailableError();
      // Redis atomically ignores an existing ID. No read-then-add race, no colons
      // (reserved by BullMQ). This is deduplication, not exactly-once execution.
      const jobId = `document-${data.organizationId}-${data.documentId}`;
      try {
        await withDeadline(readyQueue.add(DOCUMENT_JOB_NAME, data, { jobId }));
        return { jobId };
      } catch { throw new DocumentQueueUnavailableError(); }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try { await readyQueue.close(); }
      finally { connection.disconnect(); }
    },
  };
}
