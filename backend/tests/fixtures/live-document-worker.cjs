// A real worker in a separate process, restricted to this test's random queue.
// IPC shutdown works on Windows without killing unrelated application workers.
const prisma = require('../../dist/src/config/database').default;
const { createDocumentWorker } = require('../../dist/src/document/document.worker');
if (!/^nexaai-live-browser-[0-9a-f-]{36}$/.test(process.argv[2] || '')) process.exit(1);
const worker = createDocumentWorker({ queueName: process.argv[2] });
let stopping;
function stop() {
  stopping ??= worker.close().finally(() => prisma.$disconnect()).finally(() => process.disconnect?.());
  return stopping;
}
process.on('message', message => { if (message === 'stop') void stop(); });
worker.run().catch(() => { process.exitCode = 1; }).finally(stop);
