import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { redis } from '../db/redis.js';

/** Liveness and readiness probes (unauthenticated, no internal details exposed). */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ success: true, data: { status: 'ok' } }));

  app.get('/health/ready', async (_req, reply) => {
    const [db, cache] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis.ping().then(() => true).catch(() => false),
    ]);
    // Only Postgres is required to serve traffic; without Redis the API runs on its Postgres
    // fallbacks (degraded), so it must stay in the load balancer rather than be restarted.
    return reply.status(db ? 200 : 503).send({
      success: db,
      data: { database: db ? 'ok' : 'unavailable', cache: cache ? 'ok' : 'degraded' },
    });
  });
}
