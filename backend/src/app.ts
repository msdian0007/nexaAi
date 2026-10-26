import prisma from "./config/database";
import { createApiApp } from "./api";
import { getDocumentQueue, closeDocumentQueue } from "./document/document.queue.runtime";

const app = createApiApp();
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`NexaAI backend running on port ${PORT}`);
});

// Warm one producer without preventing login/chat when Redis is unavailable.
// Later document requests can reconnect; extraction runs only in the worker process.
void getDocumentQueue().catch(() =>
  console.error("Document queue is unavailable."),
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void closeDocumentQueue()
      .finally(() => prisma.$disconnect())
      .catch(() => {
        process.exitCode = 1;
      });
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
