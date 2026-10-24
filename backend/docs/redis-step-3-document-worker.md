# Phase 11, Step 11.3 — the document worker

## What problem does this solve?

Historical note: this guide records Step 11.3. Retry and crash-recovery limitations
listed below are addressed in [Step 11.4](redis-step-4-document-recovery.md).

Step 11.2 created an instruction card: "Process document X for organization Y."
Until a worker reads that card, it stays in Redis and no document work happens.
This step adds the program that reads it and does the work.

Example: a fictional handbook says employees get 18 days of annual leave. The worker
reads the handbook, divides its text into chunks, generates local embeddings, and
saves those results. Later, question answering can search the prepared chunks.
The worker does not call Gemini or answer questions.

```text
Producer -> Redis: WAITING job
                  |
                  v
             Worker: ACTIVE
                  |
             Validate job type and IDs
                  |
             Find document by documentId AND organizationId
                  |
             Claim document: PROCESSING
                  |
             Extract text -> create chunks -> local embeddings -> save vectors
                  |
             PostgreSQL document: COMPLETED
                  |
             Redis job: completed
```

The same existing `processDocument` function performs extraction and database updates.
The difference is who calls it: this worker can call it independently of an HTTP request.
For now, the upload endpoint still uses its original synchronous flow. We connect real
uploads to the queue only after recovery behavior is ready, in Step 11.5.

## Where the code lives

| File | Purpose |
| --- | --- |
| `src/config/redis.ts` | Adds a separate Redis connection for a long-running worker. |
| `src/document/document.worker.ts` | Validates jobs, calls processing, handles safe queue errors, and closes the worker. |
| `src/jobs/document.worker.main.ts` | Entry point for running the worker in a separate Node.js process. |
| `tests/document.worker.integration.test.cjs` | Checks the actual worker against Redis, PostgreSQL, files, and local embeddings. |

One worker processes one job at a time initially. This limits simultaneous local
embedding work. Multiple worker processes would increase total concurrency, so start
only one for this local setup.

A producer should return an error promptly if Redis is unavailable. A worker is a
background program, so its Redis connection keeps trying to reconnect. It uses
`maxRetriesPerRequest: null` and no short command timeout on blocking queue reads.
These are Redis connection retries, not automatic retries of failed document jobs.

## Ownership and failure behavior

An organization ID in Redis is not permission by itself. The processing service
checks both the document ID and organization ID before reading the stored file path
or changing its status. A wrong organization fails the job and leaves the document
unchanged. Malformed IDs and unknown job names are also rejected.

An ordinary extraction failure, such as a missing file, marks the document FAILED
through the existing service and fails the BullMQ job. The worker uses generic error
messages for BullMQ's persisted failure details, rather than copying raw file/database
exceptions into Redis. Its successful result contains only a document ID and status.

## Start it

Redis, PostgreSQL, uploaded files, and the local embedding model must be available.
From the **backend directory**, build and then run:

```powershell
npm.cmd run build
# Run the next command only after the build succeeds.
npm.cmd run worker:documents
```

Expected messages include:

```text
Document worker starting; waiting for queued jobs.
Document worker connected to Redis.
```

An idle worker is normal when no jobs have been submitted. The ordinary upload screen
does not submit jobs yet, so use the isolated integration test to demonstrate processing.
The API and worker must have access to the same files. Starting from `backend` keeps
relative file paths consistent with the existing upload implementation.

Press Ctrl+C for graceful shutdown. This means stop taking new work, allow the current
job to finish, then close Redis and database connections. Closing while idle is tested;
waiting for active jobs uses BullMQ's close behavior. A forced stop, power loss, or
stuck processing task is different and is part of Step 11.4.

## Reproduce the validation

From `backend`:

```powershell
npm.cmd run test:document-worker
```

The test creates its own organization, TXT file, document records, and uniquely named
queue. It runs the real worker implementation in the test process and verifies:

1. A job stays waiting before a worker starts.
2. A wrong organization cannot process or modify the document.
3. Bad payloads and unknown job names fail without processing.
4. A valid job produces extracted text, multiple chunks, and 384-dimensional vectors.
5. A missing file fails both the job and document, with a generic job error.
6. Graceful close completes; subsequent jobs remain waiting.

Cleanup removes only this test's queue, database fixtures, and files. No real user
documents are processed, and there are no Gemini requests. This test exercises the
worker implementation; it is not a full browser upload test or an operating-system
signal/shutdown test of a separate worker process.

## What remains for Step 11.4

Verified on 2026-10-11: backend build passed, and the combined worker, queue, and Redis
connection run passed all 12 reported tests (including the worker suite's parent test).
The worker saved two real chunks with 384-dimensional vectors. All fixture records,
files, and the isolated queue were cleaned up.

The producer still uses one attempt per job and retains terminal jobs. We have not
yet implemented safe crash recovery, deliberate failed-job retries, or retention cleanup.
For example, a crash after setting PROCESSING could leave that document stuck; a
redelivered completed job can rerun the current processing service. BullMQ's own
stalled-job mechanism does not by itself resolve our database state rules.

Next lesson: design what should happen when a worker stops halfway through a handbook,
then implement and test recovery before connecting this pipeline to real uploads.

References: [BullMQ workers](https://docs.bullmq.io/guide/workers/),
[worker connections](https://docs.bullmq.io/guide/connections),
[graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown).
