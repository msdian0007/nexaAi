import 'dotenv/config';
import Redis from 'ioredis';

// Do not silently connect to localhost when deployment configuration is missing.
// Only the generic error leaves this function: URLs can contain passwords.
export function getRedisUrl(value = process.env.REDIS_URL): string {
  try {
    if (!value?.trim()) throw new Error();
    const url = new URL(value.trim());
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname ||
        url.search || url.hash || !/^\/(?:\d+)?$/.test(url.pathname || '/') ||
        (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535))) {
      throw new Error();
    }
    return value.trim();
  } catch {
    throw new Error('Set REDIS_URL to a valid redis:// or rediss:// connection URL.');
  }
}

// Creating a client does not open a socket until connect() is called. Importing
// this module therefore does not make existing document/chat routes depend on Redis.
// This bounded client is for request/check operations. Workers use the separate
// createWorkerRedisConnection below so their blocking reads can wait for jobs.
export function createRedisConnection(url = getRedisUrl()): Redis {
  const client = new Redis(getRedisUrl(url), {
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: attempt => attempt <= 3 ? Math.min(attempt * 250, 1000) : null,
  });
  // Callers handle rejected operations. Consume the separate error event so the
  // library cannot print raw connection details through its default error logger.
  client.on('error', () => {});
  return client;
}

// A background worker waits for jobs and reconnects after Redis outages. Its
// blocking reads must not use the short command timeout of an HTTP producer.
export function createWorkerRedisConnection(url = getRedisUrl()): Redis {
  const client = new Redis(getRedisUrl(url), {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: attempt => Math.min(attempt * 500, 10000),
  });
  client.on('error', () => {}); // The worker logs a fixed, credential-free message.
  return client;
}
