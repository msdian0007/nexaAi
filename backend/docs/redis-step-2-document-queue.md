# Redis and background jobs: Step 2 — document queue

## What this step adds

`src/document/document.queue.ts` creates a BullMQ producer: the part of the backend
that submits work. Redis stores the jobs, so closing the producer does not erase them.
A worker is a separate consumer that takes waiting jobs and runs the processing code;
that comes in Step 3. Upload and reprocess endpoints still run synchronously in this step.

Think of a job as an instruction card:

```json
{
  "documentId": "the document's UUID",
  "organizationId": "the organization's UUID"
}
```

The queue is named `nexaai-document-processing`, and its job type is `process-document`.
The payload excludes document text, uploaded bytes, storage paths, tokens, and API keys.
The future worker loads the document using both IDs and reads its stored file path.
An organization ID inside a job is not proof of authorization: the upload handler must
use the signed-in identity, and the worker must recheck the database association.

## How submission works

1. Explicitly create the producer at application startup. Importing the module does
   not open Redis connections. A caller must close it during application shutdown.
2. Validate the IDs and copy only the two permitted payload fields.
3. Construct `document-<organizationId>-<documentId>` as the job ID.
4. BullMQ atomically adds the job to Redis. Concurrent submissions with that same ID
   produce one stored job while the ID exists.
5. Return the job ID. This acknowledges submission, not completed document processing.

An existing job is not replaced by a duplicate submission. Deduplication lasts only
while the job remains in Redis; it does not guarantee exactly-once processing.
If a connection drops after Redis accepted a job, the caller may receive an error even
though the job exists. Retrying the same IDs avoids creating a second retained job.

## Deliberate limits for this step

Jobs use one attempt and retain completed/failed records. Automatic retries, stalled-job
recovery, retention cleanup, and explicit reprocessing need to be designed with the
worker. In particular, adding an already failed job ID does not retry it. Do not wire
this producer into the existing reprocess endpoint until that lifecycle is implemented.
Retention will consume Redis memory over time; this is an interim policy before upload
integration, not a complete production retention strategy.

The producer uses the bounded Redis client from Step 1. Connection startup, BullMQ
readiness, and submission each have a ten-second deadline (the two startup stages
run sequentially). Connection errors expose a generic application error,
and event logs use a fixed message. After closing the producer, submission is rejected.
If its limited reconnect attempts are exhausted, recreate the producer. Workers will
need their own connection configured to wait for Redis recovery.

## Verification

With the local Redis container running, from `backend`:

```powershell
npm.cmd run test:document-queue
```

This builds the backend and tests real Redis submission using a unique queue name.
It checks waiting state, ID-only payloads, five concurrent duplicate submissions,
distinct organization job IDs, producer reconnection, rejection after shutdown, and
invalid inputs. A separate silent TCP endpoint checks bounded startup failure without
exposing credentials. No worker, database documents, or Gemini calls are involved.
Cleanup removes only the randomly named test queue; it never flushes the Redis database.

Verified on 2026-10-11 with BullMQ 6.3.12: backend build and all three tests passed.
The Redis test queue was removed after verification. The application upload flow has
not been connected to the producer yet, so no real documents were queued by this test.

References: [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids),
[failing fast when Redis is down](https://docs.bullmq.io/patterns/failing-fast-when-redis-is-down),
[connections](https://docs.bullmq.io/guide/connections).
