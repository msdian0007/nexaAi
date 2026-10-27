import prisma from "./config/database";
import { createApiApp } from "./api";
import { getDocumentQueue, closeDocumentQueue } from "./document/document.queue.runtime";
import { closeAdmissionStore } from "./http/usage.admission";
import { validateRuntimeConfig } from "./config/runtime";

validateRuntimeConfig("api");
const app = createApiApp();
const PORT = Number(process.env.PORT || 5000);
const server = app.listen(PORT, () => {
  console.log(`NexaAI backend running on port ${PORT}`);
});

// Warm the queue producer. Limited writes also verify allowances in Redis;
// health, history and session recovery do not need the admission connection.
// Later document requests can reconnect; extraction runs only in the worker process.
void getDocumentQueue().catch(() =>
  console.error("Document queue is unavailable."),
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void Promise.all([closeDocumentQueue(), closeAdmissionStore()])
      .finally(() => prisma.$disconnect())
      .catch(() => {
        process.exitCode = 1;
      });
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
