/**
 * Optional standalone worker process. By default workers run inside the API process
 * (WORKERS_ENABLED=true), which is what you want on a single free-tier instance.
 * When scaling the API horizontally, set WORKERS_ENABLED=false on API instances and
 * run this process once (or several times — the workers are safe to run concurrently).
 */
import { prisma } from './db/prisma.js';
import { redis } from './db/redis.js';
import { logger } from './utils/logger.js';
import { startWorkers, stopWorkers } from './workers/index.js';

// Redis is optional at boot: every request path falls back to Postgres, and ioredis keeps
// reconnecting in the background. Only Postgres is required to start.
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
await redis.connect().catch((err) => logger.error({ err }, 'redis unavailable at startup; continuing with Postgres fallbacks'));
const loops = startWorkers();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down');
  await stopWorkers(loops);
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
