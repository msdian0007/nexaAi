import { Worker, UnrecoverableError } from 'bullmq';
import { createWorkerRedisConnection } from '../config/redis';
import { DOCUMENT_JOB_NAME, DOCUMENT_QUEUE_NAME, parseDocumentJobData } from './document.queue';
import { processDocument, markInterruptedDocumentFailed } from './document.processing';
import { DocumentNotFoundError, DocumentProcessingConflictError } from './document.errors';
import { withJobTrace, emit, type LogSink } from '../observability/telemetry';

// Construction is explicit; importing this module never starts processing jobs.
// A custom queue name is server/test configuration, never user-supplied request data.
export function createDocumentWorker(options: {
  queueName?: string; url?: string;
  // Server configuration; tests shorten these to exercise actual crash recovery.
  lockDuration?: number; stalledInterval?: number;
  logSink?: LogSink;
} = {}) {
  const queueName = options.queueName ?? DOCUMENT_QUEUE_NAME;
  if (!/^[a-zA-Z0-9_-]+$/.test(queueName)) throw new Error('Invalid document queue name.');
  const connection = createWorkerRedisConnection(options.url);
  let worker: Worker;
  try {
    worker = new Worker(queueName, async job => {
      if (job.name !== DOCUMENT_JOB_NAME) throw new UnrecoverableError('Unsupported document job.');
      let data;
      try { data = parseDocumentJobData(job.data); }
      catch { throw new UnrecoverableError('Invalid document job data.'); }

      return withJobTrace(data, String(job.id), async () => { try {
        emit('stage_completed', { stage: 'queue', outcome: 'ok', durationMs: Math.max(0, Date.now() - job.timestamp) });
        // This service finds the document by BOTH IDs before reading its file or
        // changing its status. Queue payloads are instructions, not authorization.
        await processDocument(data.documentId, data.organizationId);
        // Store no extracted text or file path in BullMQ's job result.
        return { documentId: data.documentId, status: 'COMPLETED' };
      } catch (error) {
        if (error instanceof DocumentNotFoundError) {
          throw new UnrecoverableError('Document is unavailable for this organization.');
        }
        if (error instanceof DocumentProcessingConflictError) {
          throw new Error('Document is already being processed.');
        }
        // BullMQ persists failure reasons/stacks. Do not copy raw extraction or
        // database errors into Redis: they can contain local paths or credentials.
        throw new Error('Document processing failed.');
      } }, options.logSink, job.attemptsMade + 1);
    }, {
      connection,
      autorun: false,
      // Local embeddings are resource-intensive. Start with one job at a time.
      concurrency: 1,
      lockDuration: options.lockDuration ?? 30000,
      stalledInterval: options.stalledInterval ?? 30000,
      maxStalledCount: 1,
    });
  } catch (error) {
    connection.disconnect();
    throw error;
  }
  worker.on('ready', () => console.log('Document worker connected to Redis.'));
  worker.on('active', () => console.log('Document worker started a job.'));
  worker.on('completed', () => console.log('Document worker completed a job.'));
  const reconciliations = new Set<Promise<void>>();
  worker.on('failed', job => {
    console.error('Document worker job failed.');
    if (!job || job.name !== DOCUMENT_JOB_NAME) return;
    let data;
    try { data = parseDocumentJobData(job.data); } catch { return; }
    // A stalled job may exhaust its crash budget before processDocument runs.
    // The database lock prevents this callback from changing a live attempt.
    const pending = markInterruptedDocumentFailed(data.documentId, data.organizationId)
      .catch(() => { console.error('Document failure status reconciliation failed.'); });
    reconciliations.add(pending);
    void pending.finally(() => reconciliations.delete(pending));
  });
  worker.on('error', () => console.error('Document worker connection or runtime error.'));

  let closing: Promise<void> | undefined;
  return {
    run: () => worker.run(),
    close: () => {
      // Stop accepting jobs, wait for the active job, then release Redis sockets.
      // Repeated shutdown requests share the same promise. Redis redelivers
      // crashed work after its lock expires; graceful close waits for active work.
      closing ??= (async () => {
        try { await worker.close(); await Promise.all(reconciliations); }
        finally { connection.disconnect(); }
      })();
      return closing;
    },
  };
}
