import type { FastifyInstance, FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/authorize.js';
import { limits } from '../../middleware/rate-limit.js';
import { ok } from '../../utils/response.js';
import { parse } from '../../utils/validate.js';
import { requireAuthContext } from '../permissions/authorize.js';
import { revokeAllSessions, revokeSession } from '../sessions/session.service.js';
import { ChangePasswordBody, LoginBody } from './auth.schemas.js';
import { changePassword, getMe, login, meFromContext } from './auth.service.js';

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/', domain: env.COOKIE_DOMAIN });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', { preHandler: [limits.loginIp] }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const { token, session, user } = await login(body.email, body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(reply, token, session.expiresAt);
    const me = await getMe(user.id);
    return ok(reply, {
      user: me,
      session: { id: session.id, expiresAt: session.expiresAt },
      ...(env.AUTH_RETURN_TOKEN ? { token } : {}),
    });
  });

  app.post('/auth/logout', { preHandler: [requireAuth, limits.auth] }, async (req, reply) => {
    await revokeSession(requireAuthContext(req.auth).sessionId);
    clearSessionCookie(reply);
    return ok(reply, { loggedOut: true });
  });

  app.post('/auth/logout-all', { preHandler: [requireAuth, limits.auth] }, async (req, reply) => {
    const count = await revokeAllSessions(requireAuthContext(req.auth).userId);
    clearSessionCookie(reply);
    return ok(reply, { revokedSessions: count });
  });

  app.get('/auth/me', { preHandler: [requireAuth, limits.global] }, async (req, reply) => {
    return ok(reply, meFromContext(requireAuthContext(req.auth)));
  });

  app.put('/auth/password', { preHandler: [requireAuth, limits.auth] }, async (req, reply) => {
    const auth = requireAuthContext(req.auth);
    const body = parse(ChangePasswordBody, req.body);
    await changePassword(auth.userId, auth.sessionId, body.currentPassword, body.newPassword);
    return ok(reply, { changed: true });
  });
}
