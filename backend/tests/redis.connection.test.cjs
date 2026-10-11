const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { getRedisUrl, createRedisConnection } = require('../dist/src/config/redis');

test('invalid Redis configuration fails without disclosing the supplied credentials', () => {
  for (const value of ['', 'https://user:private-password@example.invalid', 'redis://', 'redis://localhost/not-a-db', 'redis://localhost:0/0', 'redis://localhost/0?password=private-password']) {
    assert.throws(() => getRedisUrl(value), error => {
      assert.equal(error.message, 'Set REDIS_URL to a valid redis:// or rediss:// connection URL.');
      assert.ok(!error.message.includes('private-password'));
      return true;
    });
  }
  assert.equal(getRedisUrl(' rediss://user:password@example.invalid:6380/1 '), 'rediss://user:password@example.invalid:6380/1');
});

test('creating a connection is lazy and does not require a running Redis server', () => {
  const client = createRedisConnection('redis://127.0.0.1:6379/0');
  try { assert.equal(client.status, 'wait'); }
  finally { client.disconnect(); }
});

test('readiness check times out against a silent server without leaking credentials', { timeout: 20000 }, async () => {
  // A TCP connection alone does not prove Redis is usable. Accept the connection
  // but send no protocol response, exercising the check's overall deadline.
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  let child;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    child = spawn(process.execPath, ['scripts/check-redis.cjs'], {
      cwd: path.resolve(__dirname, '..'), windowsHide: true,
      env: { ...process.env, REDIS_URL: `redis://user:private-password@127.0.0.1:${server.address().port}/0` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(output, /Redis check failed/);
    assert.ok(!output.includes('private-password'));
    assert.ok(!output.includes('redis://'));
  } finally {
    if (child && child.exitCode === null) child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
