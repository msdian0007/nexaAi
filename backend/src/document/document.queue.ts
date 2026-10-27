import { Queue } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { traceId, submitted } from '../observability/telemetry';

export const DOCUMENT_QUEUE_NAME = 'nexaai-document-processing';
export const DOCUMENT_JOB_NAME = 'process-document';
export type DocumentJobData = { documentId: string; organizationId: string; requestId?: string };

export class DocumentQueueUnavailableError extends Error {
  constructor() { super('Document processing queue is unavailable.'); }
}

export class DocumentJobRetryError extends Error {
  constructor() { super('Only an existing failed document job can be retried.'); }
}

// Runtime validation is needed even with TypeScript: jobs can come from JavaScript
// callers today and persisted Redis data later. Copy only the fields the worker needs.
export function parseDocumentJobData(value: unknown): DocumentJobData {
  const data = value as Partial<DocumentJobData> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!data || typeof data.documentId !== 'string' || !uuid.test(data.documentId) ||
      typeof data.organizationId !== 'string' || !uuid.test(data.organizationId) ||
      (data.requestId !== undefined && (typeof data.requestId !== 'string' || !uuid.test(data.requestId)))) {
    throw new Error('Document jobs require valid document and organization UUIDs.');
  }
  return { documentId: data.documentId, organizationId: data.organizationId, ...(data.requestId ? { requestId: data.requestId } : {}) };
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
        // Three total attempts, waiting 2 then 4 seconds after ordinary failures.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // Cleanup happens as jobs finish, not on a background expiry timer.
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 1000 },
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
    isReady: () => !closed && connection.status === 'ready',
    async checkConnection(): Promise<boolean> {
      if (closed || connection.status !== 'ready') return false;
      return await withDeadline(connection.ping()) === 'PONG';
    },
    async workerCount(): Promise<number> {
      if (closed || connection.status !== 'ready') throw new DocumentQueueUnavailableError();
      return (await withDeadline(readyQueue.getWorkers())).length;
    },
    async getState(value: unknown): Promise<string> {
      const data = parseDocumentJobData(value);
      if (closed || connection.status !== 'ready') throw new DocumentQueueUnavailableError();
      try {
        // Read only a state, never return Redis failure stacks or document contents.
        return await withDeadline(readyQueue.getJobState(`document-${data.organizationId}-${data.documentId}`));
      } catch { throw new DocumentQueueUnavailableError(); }
    },
    async enqueue(value: unknown): Promise<{ jobId: string }> {
      const data = parseDocumentJobData(value);
      if (closed || connection.status !== 'ready') throw new DocumentQueueUnavailableError();
      // Redis atomically ignores an existing ID. No read-then-add race, no colons
      // (reserved by BullMQ). This is deduplication, not exactly-once execution.
      const jobId = `document-${data.organizationId}-${data.documentId}`;
      try {
        const requestId = traceId();
        await withDeadline(readyQueue.add(DOCUMENT_JOB_NAME, { ...data, ...(requestId ? { requestId } : {}) }, { jobId }));
        submitted(data.documentId, data.organizationId, jobId);
        return { jobId };
      } catch { throw new DocumentQueueUnavailableError(); }
    },
    async retryFailed(value: unknown): Promise<{ jobId: string }> {
      const data = parseDocumentJobData(value);
      if (closed || connection.status !== 'ready') throw new DocumentQueueUnavailableError();
      const jobId = `document-${data.organizationId}-${data.documentId}`;
      try {
        const job = await withDeadline(readyQueue.getJob(jobId));
        if (!job || job.name !== DOCUMENT_JOB_NAME ||
            job.data.documentId !== data.documentId || job.data.organizationId !== data.organizationId) {
          throw new DocumentJobRetryError();
        }
        // BullMQ atomically requires FAILED. Reset the budget for deliberate retries.
        // BullMQ 6 retry() resets attempt counts but keeps the stalled-job marker.
        // Clear that marker ONLY while Redis still lists this job as failed;
        // otherwise a manual retry after repeated crashes would fail immediately.
        // retry() below still atomically decides which concurrent caller wins.
        await withDeadline(connection.eval(`
          if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
            redis.call('HDEL', KEYS[2], 'defa', 'stc')
          end
          return 1
        `, 2, readyQueue.toKey('failed'), readyQueue.toKey(jobId), jobId));
        await withDeadline(job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true }));
        submitted(data.documentId, data.organizationId, jobId);
        return { jobId };
      } catch (error) {
        if (error instanceof DocumentQueueUnavailableError || connection.status !== 'ready') {
          throw new DocumentQueueUnavailableError();
        }
        throw new DocumentJobRetryError();
      }
    },
    async removeIfIdle(value: unknown): Promise<boolean> {
      const data = parseDocumentJobData(value);
      if (closed || connection.status !== 'ready') throw new DocumentQueueUnavailableError();
      try {
        const job = await withDeadline(readyQueue.getJob(`document-${data.organizationId}-${data.documentId}`));
        if (!job) return true;
        if (job.data.documentId !== data.documentId || job.data.organizationId !== data.organizationId)
          throw new DocumentQueueUnavailableError();
        // BullMQ's remove checks the job lock atomically. Never force-remove an
        // active worker's job; it will observe deletion intent and stop safely.
        try { await withDeadline(job.remove()); return true; }
        catch {
          if (await withDeadline(job.getState()) === 'active') return false;
          throw new DocumentQueueUnavailableError();
        }
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
