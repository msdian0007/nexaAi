// Read-only readiness check: no keys are created, deleted or flushed.
const { createRedisConnection } = require('../dist/src/config/redis');

async function main() {
  let client;
  let deadline;
  try {
    client = createRedisConnection();
    // Bound the entire check, including reconnects and commands, not just TCP setup.
    await Promise.race([
      (async () => {
        await client.connect();
        if (await client.ping() !== 'PONG') throw new Error('Unexpected reply');
        const memory = await client.info('memory');
        const persistence = await client.info('persistence');
        if (!/^maxmemory_policy:noeviction\r?$/m.test(memory)) {
          throw new Error('NOEVICTION_REQUIRED');
        }
        if (!/^aof_enabled:1\r?$/m.test(persistence)) {
          throw new Error('AOF_REQUIRED');
        }
      })(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('CHECK_TIMEOUT')), 10000); }),
    ]);
    console.log('Redis ready: PONG; noeviction enabled; append-only persistence enabled.');
  } catch (error) {
    // Never print the raw error, stack, URL, username or password.
    const messages = {
      NOEVICTION_REQUIRED: 'Redis responded, but maxmemory-policy must be noeviction for the queue.',
      AOF_REQUIRED: 'Redis responded, but append-only persistence is not enabled for this local setup.',
    };
    console.error(messages[error?.message] || 'Redis check failed. Check REDIS_URL, server availability, credentials and INFO permissions.');
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    // Immediate disconnect also works when the server is down; QUIT could wait.
    client?.disconnect();
  }
}
void main();
