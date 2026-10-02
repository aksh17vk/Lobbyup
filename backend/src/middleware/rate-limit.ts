import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { keys, redis } from '../db/redis.js';
import { AppError } from '../utils/errors.js';

export interface RateLimitOptions {
  name: string;
  max: number;
  windowSeconds: number;
  /** 'user' falls back to IP for anonymous requests. Use 'ip' only for pre-auth endpoints. */
  by?: 'user' | 'ip';
}

/** Fixed-window counter in Redis, shared across instances. */
export async function consume(name: string, subject: string, max: number, windowSeconds: number) {
  const windowMs = windowSeconds * 1000;
  const window = Math.floor(Date.now() / windowMs);
  const count = await redis.luRateLimit(keys.rate(name, subject, window), windowMs);
  const resetMs = (window + 1) * windowMs - Date.now();
  return { allowed: count <= max, count, remaining: Math.max(0, max - count), resetMs };
}

/**
 * Keyed by user id where possible: an entire exam hall behind one NAT IP must not
 * share a single bucket. Fails open if Redis is unreachable.
 */
export function rateLimit(opts: RateLimitOptions) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!env.RATE_LIMIT_ENABLED) return;
    const subject = opts.by !== 'ip' && req.auth ? `u:${req.auth.userId}` : `ip:${req.ip}`;
    let r;
    try {
      r = await consume(opts.name, subject, opts.max, opts.windowSeconds);
    } catch (err) {
      req.log.warn({ err }, 'rate limiter unavailable; failing open');
      return;
    }
    reply.header('x-ratelimit-limit', opts.max);
    reply.header('x-ratelimit-remaining', r.remaining);
    if (!r.allowed) {
      const retry = Math.max(1, Math.ceil(r.resetMs / 1000));
      reply.header('retry-after', retry);
      throw new AppError('RATE_LIMITED', `Too many requests. Retry in ${retry}s.`, { retryAfterSeconds: retry });
    }
  };
}

/**
 * Limits sized for ~500 students. Autosave is expected to be debounced client-side
 * (every 5–15 s), so these leave large headroom for normal exam usage.
 */
export const limits = {
  global: rateLimit({ name: 'global', max: 600, windowSeconds: 60 }),
  // High on purpose: a whole lab may share one NAT address; per-account lockout stops brute force.
  loginIp: rateLimit({ name: 'login-ip', max: env.LOGIN_RATE_LIMIT_PER_IP, windowSeconds: 60, by: 'ip' }),
  auth: rateLimit({ name: 'auth', max: 30, windowSeconds: 60 }),
  attemptStart: rateLimit({ name: 'attempt-start', max: 20, windowSeconds: 60 }),
  answer: rateLimit({ name: 'answer', max: 180, windowSeconds: 60 }),
  sync: rateLimit({ name: 'sync', max: 30, windowSeconds: 60 }),
  submit: rateLimit({ name: 'submit', max: 10, windowSeconds: 60 }),
  events: rateLimit({ name: 'events', max: 60, windowSeconds: 60 }),
  admin: rateLimit({ name: 'admin', max: 300, windowSeconds: 60 }),
};
