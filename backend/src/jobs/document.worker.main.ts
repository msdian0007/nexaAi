import prisma from '../config/database';
import { createDocumentWorker } from '../document/document.worker';
import { validateRuntimeConfig } from '../config/runtime';

// Run this entry point from backend so stored relative upload paths resolve the
// same way as they do in the API. The API and worker must share the uploaded files.
async function main() {
  validateRuntimeConfig('worker');
  const worker = createDocumentWorker();
  let shutdown: Promise<void> | undefined;
  const stop = () => {
    shutdown ??= (async () => {
      console.log('Document worker stopping; waiting for active work.');
      try { await worker.close(); }
      finally { await prisma.$disconnect(); }
    })();
    return shutdown;
  };
  const onSignal = () => { void stop().catch(() => {
    console.error('Document worker shutdown failed.');
    process.exitCode = 1;
  }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    console.log('Document worker starting; waiting for queued jobs.');
    await worker.run();
  } finally {
    await stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

void main().catch(async () => {
  console.error('Document worker could not run. Check Redis and database configuration.');
  process.exitCode = 1;
  await prisma.$disconnect();
});
