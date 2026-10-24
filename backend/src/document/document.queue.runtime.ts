import { createDocumentQueue, DocumentQueueUnavailableError } from './document.queue';

export type DocumentQueue = Awaited<ReturnType<typeof createDocumentQueue>>;
export type QueueProvider = () => Promise<DocumentQueue>;
let connecting: Promise<DocumentQueue> | undefined;
let stopping = false;

// Share one producer across HTTP requests. Recreate a disconnected producer on a
// later request so restoring Redis does not require restarting the API process.
export const getDocumentQueue: QueueProvider = async () => {
  if (stopping) throw new DocumentQueueUnavailableError();
  if (connecting) {
    const previous = connecting;
    const queue = await previous;
    if (queue.isReady()) return queue;
    if (connecting === previous) {
      connecting = undefined;
      await queue.close();
    }
  }
  if (stopping) throw new DocumentQueueUnavailableError();
  if (!connecting) {
    const pending = createDocumentQueue();
    connecting = pending;
    void pending.catch(() => { if (connecting === pending) connecting = undefined; });
  }
  return connecting;
};

export async function closeDocumentQueue() {
  stopping = true;
  const pending = connecting;
  connecting = undefined;
  const queue = await pending?.catch(() => undefined);
  await queue?.close();
}
