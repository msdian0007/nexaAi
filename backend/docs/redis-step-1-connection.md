# Redis and background jobs: Step 1 — local Redis connection

## What each component does

PostgreSQL remains the source of truth for documents, chunks, users, and conversations.
Redis will hold BullMQ's processing jobs. A job is a small instruction, such as
"process document ID X," which a separate worker can pick up. Upload handling can
then return while extraction and embeddings run outside the HTTP request.

This step prepares Redis and its connection check. BullMQ, workers, and changes to
the upload response belong to the following steps. Existing routes do not import
the Redis client yet and do not depend on Redis being available.

## Files and settings

- Root `docker-compose.yml`: adds Redis 7.4, a loopback-only port, a health check,
  and the named `redis_data` volume. Start only the `redis` service if PostgreSQL
  is already installed/running separately.
- `backend/.env.redis.example`: the one setting to add to your existing `.env`:
  `REDIS_URL=redis://127.0.0.1:6379/0`. The final `/0` selects Redis database zero.
  Never replace your whole existing `.env` with this small example.
- `src/config/redis.ts`: validates configuration and creates a lazy ioredis client.
  Lazy means no socket is opened just by importing or creating the client.
- `scripts/check-redis.cjs`: connects, sends PING, checks queue-related settings,
  then disconnects. The entire check has a ten-second deadline and hides credentials.

The client dependency is ioredis 5, a supported line for BullMQ integration. The
request/check client limits retries and disables buffering commands while offline.
Future workers need a separate connection with `maxRetriesPerRequest: null`; a worker
waits for Redis recovery, whereas a user request should return an error promptly.

## Why the Redis settings matter

`appendonly yes` writes changes to an append-only log in the volume. The `everysec`
sync policy normally limits crash-related loss to roughly one second; it is not a
zero-loss guarantee. The volume survives ordinary container restarts/removal, but
explicitly deleting the volume deletes its data.

`maxmemory-policy noeviction` prevents Redis from automatically removing job keys to
make room. When a configured memory limit is reached, writes fail instead. This
does not set a memory limit or prevent the host from running out of memory.

The port binding exposes this development Redis only on `127.0.0.1`. A hosted
deployment needs its own authenticated connection and persistence setup; `rediss://`
enables TLS. This readiness script requires permission to read Redis INFO sections.

References: [BullMQ connections](https://docs.bullmq.io/guide/connections),
[BullMQ production settings](https://docs.bullmq.io/guide/going-to-production),
[Redis persistence](https://redis.io/docs/latest/management/persistence/).

## Start and verify

Install/start [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
using the WSL 2 backend. Finish any Windows restart or Docker first-run steps it
requires before running these commands.

From the repository root:

```powershell
docker compose up -d redis
docker compose ps redis
docker compose exec -T redis redis-cli ping
```

From `backend`:

```powershell
npm.cmd run check:redis
node --test tests/redis.connection.test.cjs
```

Expected check output: `Redis ready: PONG; noeviction enabled; append-only persistence enabled.`
The check reads status only and does not create or delete keys. The test suite checks
invalid configuration, lazy connections, and a nonresponsive server's failure path;
those tests do not prove a real Redis server is running.

Stop only Redis with `docker compose stop redis`. Avoid `docker compose down -v`,
which would also remove this project's database volumes.

## Current verification — 2026-10-10

- Backend TypeScript build passed; all three connection tests passed.
- Docker Desktop 4.94.0 installed successfully in per-user mode after its installer
  checksum was verified. Docker CLI reports 29.8.2; Compose configuration validation passed.
- WSL setup completed and reports WSL 3.0.1.0. However, `wsl --status` reports
  `WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED`, and Windows reports a pending reboot.
- The local `REDIS_URL` setting was added to the ignored backend `.env`.
- Live Redis readiness is **not verified yet**. Restart Windows, open Docker Desktop,
  and finish the start/verify commands above before beginning the queue step. If WSL
  still reports the optional-component error after restarting, complete Windows'
  administrator WSL feature setup before retrying Docker.

For an existing terminal that does not yet have Docker on PATH, reopen PowerShell or
use the installed executable at
`$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe`.
