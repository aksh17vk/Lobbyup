import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { resolveSession } from '../modules/sessions/session.service.js';
import type { AuthContext } from '../modules/permissions/authorize.js';
import { AppError } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function extractToken(req: FastifyRequest): { token: string; via: AuthContext['via'] } | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return { token: header.slice(7).trim(), via: 'bearer' };
  const cookie = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (cookie) return { token: cookie, via: 'cookie' };
  return null;
}

/**
 * Identifies the caller on every request (does not enforce). Routes enforce with
 * `requireAuth` / `requirePermission`. Also applies CSRF protection to
 * cookie-authenticated state-changing requests.
 */
export const authPlugin = fp(async (app) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    const found = extractToken(req);
    if (!found) return;
    req.auth = await resolveSession(found.token, found.via);

    if (req.auth && found.via === 'cookie' && UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        if (!env.CORS_ORIGINS.includes(origin)) throw new AppError('CSRF_REJECTED', 'Origin not allowed.');
      } else if (!req.headers['x-requested-with']) {
        // No Origin header: require a custom header, which a cross-site form cannot send
        // without passing a CORS preflight.
        throw new AppError('CSRF_REJECTED', 'Missing Origin or X-Requested-With header.');
      }
    }
  });
});
