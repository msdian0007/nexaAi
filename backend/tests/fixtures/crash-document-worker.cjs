// Child process used only by the crash integration test. Pause after real chunk
// writes so the parent can kill this process while its transaction is open.
function stub(modulePath, exports) {
  const id = require.resolve(modulePath);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../../dist/src/document/document.extractor', {
  extractTextFromDocument: async () => 'Fictional handbook: 18 annual leave days.',
});
stub('../../dist/src/document/document.embedding.service', {
  embedDocumentChunks: async () => {
    process.send('partial-work');
    await new Promise(() => {});
  },
});
const { createDocumentWorker } = require('../../dist/src/document/document.worker');
const worker = createDocumentWorker({ queueName: process.argv[2], lockDuration: 2000, stalledInterval: 1000 });
worker.run().catch(() => process.exit(1));
