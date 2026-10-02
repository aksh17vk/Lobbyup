import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { redis } from './db/redis.js';
import { logger } from './utils/logger.js';
import { startWorkers, stopWorkers } from './workers/index.js';
import type { Loop } from './workers/loop.js';

// Redis is optional at boot: every request path falls back to Postgres, and ioredis keeps
// reconnecting in the background. Only Postgres is required to start.
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
await redis.connect().catch((err) => logger.error({ err }, 'redis unavailable at startup; continuing with Postgres fallbacks'));
await prisma.$connect();

const app = await buildApp();
const loops: Loop[] = env.WORKERS_ENABLED ? startWorkers() : [];

await app.listen({ host: env.HOST, port: env.PORT });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  try {
    await app.close(); // stop accepting requests, finish in-flight ones
    await stopWorkers(loops); // flush buffered answers to Postgres before exiting
  } finally {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
