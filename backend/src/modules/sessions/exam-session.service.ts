import type { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { isUniqueViolation, prisma } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { getAttemptMeta, queueCacheRepair, refreshAttemptMetaBestEffort, type AttemptMeta } from '../attempts/attempt.cache.js';
import { recordServerEvent } from '../exam-events/event.service.js';
import type { AuthContext } from '../permissions/authorize.js';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
  deviceInfo?: Prisma.InputJsonValue;
}

const GRACE_MS = () => env.SUBMIT_GRACE_SECONDS * 1000;

class SessionRace extends Error {}

/**
 * Opens (or re-uses) the single ACTIVE exam session that may write to an attempt.
 *
 *  - Same login session (page reload, brief disconnect)  → re-use the existing exam session.
 *  - Different login/device                               → supersede the old one (logged as a
 *    SESSION_CHANGE signal for human review), or reject if EXAM_SESSION_TAKEOVER=deny.
 *
 * Takeover (supersede + create + SESSION_CHANGE signal) is ONE transaction, so the signal can
 * never be lost. The Redis copy is refreshed right after; if that fails, every later write
 * re-checks Postgres before rejecting (see assertCurrentExamSession), so a stale cache heals.
 * A crashed laptop must never lock a student out, so takeover is allowed by default; it is
 * recorded rather than treated as proof of cheating.
 */
export async function openExamSession(
  attempt: { id: string; userId: string; expiresAt: Date },
  auth: AuthContext,
  client: ClientInfo,
  retry = true,
): Promise<{ id: string; tookOver: boolean }> {
  const active = await prisma.examSession.findFirst({ where: { attemptId: attempt.id, status: 'ACTIVE' } });

  if (active && active.authSessionId === auth.sessionId) {
    // Reconcile the cache in case an earlier takeover committed but its cache refresh failed.
    const cached = await getAttemptMeta(attempt.id).catch(() => null);
    if (!cached || cached.examSessionId !== active.id) await refreshAttemptMetaBestEffort(attempt.id);
    return { id: active.id, tookOver: false };
  }
  if (active && env.EXAM_SESSION_TAKEOVER === 'deny') {
    throw new AppError('EXAM_SESSION_ACTIVE_ELSEWHERE', 'This exam is already open on another device.');
  }

  if (active) {
    // Fence first: from this instant the old device can no longer write through the cache. If Redis
    // is unreachable the takeover still proceeds (availability); the cache is repaired on reconnect
    // and anything the old session writes after being superseded is never persisted.
    await redis.luFenceSession(keys.attemptMeta(attempt.id)).catch(() => queueCacheRepair(attempt.id));
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Serialise with finalisation: never open a session on (or score a takeover against) an
      // attempt that has just been submitted or expired.
      const [row] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`;
      if (row?.status !== 'IN_PROGRESS') {
        throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt is no longer in progress.');
      }
      if (active) {
        const superseded = await tx.examSession.updateMany({
          where: { id: active.id, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED', endedAt: new Date() },
        });
        // The session changed under us (closed or already superseded): re-evaluate from scratch.
        if (superseded.count === 0) throw new SessionRace();
      }
      const s = await tx.examSession.create({
        data: {
          attemptId: attempt.id,
          userId: attempt.userId,
          authSessionId: auth.sessionId,
          ipAddress: client.ip,
          userAgent: client.userAgent?.slice(0, 512),
          deviceInfo: client.deviceInfo,
          expiresAt: new Date(attempt.expiresAt.getTime() + GRACE_MS()),
        },
      });
      if (active) {
        await recordServerEvent(
          attempt.id,
          attempt.userId,
          s.id,
          'SESSION_CHANGE',
          `server:session-change:${s.id}`,
          {
            previousExamSessionId: active.id,
            previousIp: active.ipAddress,
            newIp: client.ip ?? null,
            previousUserAgent: active.userAgent,
            newUserAgent: client.userAgent ?? null,
          },
          tx,
        );
      }
      return s;
    });

    await refreshAttemptMetaBestEffort(attempt.id);
    return { id: created.id, tookOver: !!active };
  } catch (err) {
    // Two devices raced: the partial unique index allowed only one. Re-evaluate once.
    if (retry && (isUniqueViolation(err) || err instanceof SessionRace)) return openExamSession(attempt, auth, client, false);
    // The takeover did not happen: lift the fence (writes would also self-heal on the next request).
    if (active) await refreshAttemptMetaBestEffort(attempt.id).catch(() => {});
    if (err instanceof SessionRace) throw new AppError('CONFLICT', 'Exam session changed concurrently; please retry.');
    throw err;
  }
}

/** Synchronous check against the given (possibly cached) state. */
export function assertExamSession(meta: AttemptMeta, examSessionId: string | undefined) {
  if (!examSessionId) throw new AppError('EXAM_SESSION_REQUIRED', 'Missing X-Exam-Session-Id header.');
  if (meta.examSessionId !== examSessionId) {
    throw new AppError(
      'EXAM_SESSION_SUPERSEDED',
      'This exam was opened in another window or device. Resume the attempt to continue here.',
    );
  }
}

/**
 * Every write to an attempt must come from its current exam session. A mismatch against the cache
 * is re-checked against Postgres once before rejecting, so a stale cache can never lock out the
 * legitimate device.
 */
export async function assertCurrentExamSession(meta: AttemptMeta, examSessionId: string | undefined): Promise<AttemptMeta> {
  if (!examSessionId) throw new AppError('EXAM_SESSION_REQUIRED', 'Missing X-Exam-Session-Id header.');
  if (meta.examSessionId === examSessionId) return meta;
  const fresh = await refreshAttemptMetaBestEffort(meta.attemptId);
  assertExamSession(fresh, examSessionId);
  return fresh;
}

/**
 * Record exam-session activity at most once a minute per session. Throttled in process memory
 * (no Redis round trip on the hot autosave path); each instance writes at most once a minute.
 */
const lastTouch = new Map<string, number>();
const TOUCH_EVERY_MS = 60_000;

export function touchExamSession(examSessionId: string) {
  const now = Date.now();
  const prev = lastTouch.get(examSessionId);
  if (prev !== undefined && now - prev < TOUCH_EVERY_MS) return;
  lastTouch.set(examSessionId, now);
  if (lastTouch.size > 20_000) {
    for (const [k, t] of lastTouch) if (now - t > 5 * TOUCH_EVERY_MS) lastTouch.delete(k);
  }
  prisma.examSession
    .update({ where: { id: examSessionId }, data: { lastActivityAt: new Date() } })
    .catch((err) => logger.debug({ err }, 'exam session touch failed'));
}

export async function closeExamSessions(attemptId: string) {
  await prisma.examSession.updateMany({
    where: { attemptId, status: 'ACTIVE' },
    data: { status: 'CLOSED', endedAt: new Date() },
  });
}
