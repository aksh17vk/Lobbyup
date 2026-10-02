import type { FastifyError, FastifyInstance } from 'fastify';
import { isProd } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * Every error leaves the API as:
 *   { success: false, error: { code, message, details? } }
 * Stack traces, SQL and infrastructure details are never sent to clients in production.
 */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      return reply.status(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }

    const prismaCode = (err as { code?: string }).code;
    // Database overloaded / unreachable (pool timeout, transaction could not start, connection lost):
    // a retryable 503, so clients back off and retry instead of treating it as a hard failure.
    const pgCode = (err as { meta?: { code?: string } }).meta?.code;
    const transientPg = prismaCode === 'P2010' && (pgCode === '55P03' || pgCode === '40P01' || pgCode === '57014');
    if (transientPg || (prismaCode && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'].includes(prismaCode))) {
      req.log.warn({ err }, 'database unavailable');
      reply.header('retry-after', 2);
      return reply.status(503).send({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is busy. Please retry shortly.' },
      });
    }
    if (prismaCode === 'P2002') {
      return reply.status(409).send({ success: false, error: { code: 'CONFLICT', message: 'Resource already exists.' } });
    }
    if (prismaCode === 'P2025') {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
    }

    const fe = err as FastifyError;
    // Fastify's own client errors (malformed JSON, body too large, unsupported media type).
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      const code = fe.statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : fe.statusCode === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
      return reply.status(fe.statusCode).send({
        success: false,
        error: { code, message: fe.statusCode === 413 ? 'Request body too large.' : 'Malformed request.' },
      });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        ...(isProd ? {} : { details: { message: err.message } }),
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
  );
}
