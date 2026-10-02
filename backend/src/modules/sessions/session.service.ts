import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { generateToken, sha256 } from '../../utils/crypto.js';
import type { AuthContext } from '../permissions/authorize.js';

const CACHE_TTL_SECONDS = 60;
const TOUCH_EVERY_SECONDS = 60;
const TOMBSTONE = '!invalidated';

interface CachedSession {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  studentId: string | null;
  roles: string[];
  permissions: string[];
  expiresAt: number;
  lastActivityAt: number;
}

export async function createSession(userId: string, meta: { ip?: string; userAgent?: string }) {
  const token = generateToken();
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      ipAddress: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512),
      expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000),
    },
  });
  return { token, session };
}

async function loadFromDb(tokenHash: string): Promise<CachedSession | null> {
  const s = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
      },
    },
  });
  if (!s || s.status !== 'ACTIVE' || s.user.status !== 'ACTIVE') return null;
  const permissions = new Set<string>();
  for (const ur of s.user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
  return {
    sessionId: s.id,
    userId: s.userId,
    email: s.user.email,
    fullName: s.user.fullName,
    studentId: s.user.studentId,
    roles: s.user.roles.map((r) => r.role.name),
    permissions: [...permissions],
    expiresAt: s.expiresAt.getTime(),
    lastActivityAt: s.lastActivityAt.getTime(),
  };
}

/**
 * Resolve an opaque token to an AuthContext. Checks absolute expiry, idle timeout,
 * revocation and account status. Hot path is a single Redis GET.
 */
export async function resolveSession(
  token: string,
  via: AuthContext['via'],
  skipCache = false,
): Promise<AuthContext | null> {
  if (token.length < 20 || token.length > 200) return null;
  const tokenHash = sha256(token);
  const cacheKey = keys.session(tokenHash);

  let cached: CachedSession | null = null;
  let fromCache = false;
  let rawCached: string | null = null;
  try {
    const raw = skipCache ? null : await redis.get(cacheKey);
    if (raw && raw !== TOMBSTONE) {
      cached = JSON.parse(raw) as CachedSession;
      fromCache = true;
      rawCached = raw;
    }
  } catch {
    /* Redis unavailable: fall through to Postgres */
  }
  if (!cached) {
    cached = await loadFromDb(tokenHash);
    if (!cached) return null;
    // NX: never overwrite a revocation tombstone written while this load was in flight.
    redis.set(cacheKey, JSON.stringify(cached), 'EX', CACHE_TTL_SECONDS, 'NX').catch(() => {});
  }

  const now = Date.now();
  if (cached.expiresAt <= now) {
    await expireSession(cached.sessionId, tokenHash);
    return null;
  }
  const idleMs = env.SESSION_IDLE_MINUTES * 60_000;
  const lastSeen = Math.max(cached.lastActivityAt, lastTouch.get(cached.sessionId) ?? 0);
  if (lastSeen + idleMs <= now) {
    if (fromCache) {
      // The cached activity time may be stale (another instance may have touched it): re-check Postgres.
      // Compare-and-delete: never erase a revocation tombstone written since our read.
      await redis.luDelIfEq(cacheKey, rawCached!).catch(() => {});
      return resolveSession(token, via, true);
    }
    // Conditional: a concurrent touch that just refreshed the session wins.
    await expireSession(cached.sessionId, tokenHash, new Date(now - idleMs));
    return null;
  }

  touch(cached.sessionId, cached.lastActivityAt);

  return {
    userId: cached.userId,
    sessionId: cached.sessionId,
    email: cached.email,
    fullName: cached.fullName,
    studentId: cached.studentId ?? null,
    roles: cached.roles,
    permissions: new Set(cached.permissions),
    via,
  };
}

/**
 * Update last_activity_at at most once a minute per session per instance. Throttled in process
 * memory, so the hot path costs no extra Redis or Postgres round trip.
 */
const lastTouch = new Map<string, number>();
function touch(sessionId: string, knownLastActivity: number) {
  const now = Date.now();
  const prev = Math.max(lastTouch.get(sessionId) ?? 0, knownLastActivity);
  if (now - prev < TOUCH_EVERY_SECONDS * 1000) return;
  lastTouch.set(sessionId, now);
  if (lastTouch.size > 50_000) {
    for (const [k, t] of lastTouch) if (now - t > 10 * TOUCH_EVERY_SECONDS * 1000) lastTouch.delete(k);
  }
  prisma.session.update({ where: { id: sessionId }, data: { lastActivityAt: new Date(now) } }).catch(() => {});
}

async function expireSession(sessionId: string, tokenHash: string, idleBefore?: Date) {
  await prisma.session
    .updateMany({
      where: { id: sessionId, status: 'ACTIVE', ...(idleBefore ? { lastActivityAt: { lte: idleBefore } } : {}) },
      data: { status: 'EXPIRED' },
    })
    .catch(() => {});
  await redis.del(keys.session(tokenHash)).catch(() => {});
}

/**
 * Revocation/invalidation writes a short tombstone instead of deleting the cache entry, so a
 * cache fill from a request that loaded the session just before the revocation (SET … NX)
 * cannot bring the revoked/stale context back.
 */
async function tombstone(tokenHashes: string[]) {
  if (!tokenHashes.length) return;
  const m = redis.multi();
  for (const h of tokenHashes) m.set(keys.session(h), TOMBSTONE, 'EX', CACHE_TTL_SECONDS);
  await m.exec().catch(() => {});
}

export async function revokeSession(sessionId: string) {
  const s = await prisma.session.update({
    where: { id: sessionId },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await tombstone([s.tokenHash]);
}

/** Revoke all of a user's sessions (password reset, suspension). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, status: 'ACTIVE', ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    select: { id: true, tokenHash: true },
  });
  if (sessions.length === 0) return 0;
  await prisma.session.updateMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await tombstone(sessions.map((s) => s.tokenHash));
  return sessions.length;
}

/** Drop cached auth contexts so role/permission changes apply immediately. */
export async function invalidateSessionCacheForUsers(userIds: string[]) {
  if (userIds.length === 0) return;
  const sessions = await prisma.session.findMany({
    where: { userId: { in: userIds }, status: 'ACTIVE' },
    select: { tokenHash: true },
  });
  await tombstone(sessions.map((s) => s.tokenHash));
}
