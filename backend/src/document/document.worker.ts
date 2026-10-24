import { Worker, UnrecoverableError } from 'bullmq';
import { createWorkerRedisConnection } from '../config/redis';
import { DOCUMENT_JOB_NAME, DOCUMENT_QUEUE_NAME, parseDocumentJobData } from './document.queue';
import { processDocument } from './document.processing';
import { DocumentNotFoundError, DocumentProcessingConflictError } from './document.errors';

// Construction is explicit; importing this module never starts processing jobs.
// A custom queue name is server/test configuration, never user-supplied request data.
export function createDocumentWorker(options: { queueName?: string; url?: string } = {}) {
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

      try {
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
      }
    }, {
      connection,
      autorun: false,
      // Local embeddings are resource-intensive. Start with one job at a time.
      concurrency: 1,
    });
  } catch (error) {
    connection.disconnect();
    throw error;
  }
  worker.on('ready', () => console.log('Document worker connected to Redis.'));
  worker.on('active', () => console.log('Document worker started a job.'));
  worker.on('completed', () => console.log('Document worker completed a job.'));
  worker.on('failed', () => console.error('Document worker job failed.'));
  worker.on('error', () => console.error('Document worker connection or runtime error.'));

  let closing: Promise<void> | undefined;
  return {
    run: () => worker.run(),
    close: () => {
      // Stop accepting jobs, wait for the active job, then release Redis sockets.
      // Repeated shutdown requests share the same promise. Forced/crash recovery
      // is Step 11.4; a graceful close intentionally waits for active work.
      closing ??= (async () => {
        try { await worker.close(); }
        finally { connection.disconnect(); }
      })();
      return closing;
    },
  };
}
