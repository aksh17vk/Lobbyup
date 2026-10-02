import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { attemptRoutes } from './modules/attempts/attempt.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { quizRoutes } from './modules/quizzes/quiz.routes.js';
import { resultRoutes } from './modules/results/result.routes.js';
import { authPlugin } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { healthRoutes } from './plugins/health.js';
import { logger } from './utils/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Trust exactly N proxy hops (e.g. the platform load balancer) for req.ip.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // Bounds how long a client may take to SEND a request (slow-body protection). Handler time is
    // bounded by REDIS_COMMAND_TIMEOUT_MS, Prisma pool/transaction timeouts and lock_timeout.
    requestTimeout: 30_000,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  registerErrorHandler(app);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // API responses are per-user and must never be cached by shared proxies.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  await app.register(helmet, {
    // Pure JSON API: lock everything down.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (no Origin) are allowed; browsers must be on the allowlist.
      if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-exam-session-id', 'x-requested-with', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(quizRoutes);
      await v1.register(attemptRoutes);
      await v1.register(resultRoutes);
      await v1.register(adminRoutes, { prefix: '/admin' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
