import { Prisma, type AttemptStatus, type ExamEventType } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma, type Tx } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { AppError } from '../../utils/errors.js';
import { getAttemptMeta } from '../attempts/attempt.cache.js';
import type { AuthContext } from '../permissions/authorize.js';
import type { EventItemT } from './event.schemas.js';
import { weightOf } from './signals.js';

/** Events queued offline and flushed right after the attempt closed are still accepted briefly. */
const LATE_EVENT_WINDOW_MS = 10 * 60_000;

interface NewEvent {
  type: ExamEventType;
  clientEventId: string;
  clientTimestamp: Date | null;
  metadata?: Prisma.InputJsonValue;
  weight: number;
}

/**
 * Insert events and apply their weights in ONE transaction, so a failure between the two can never
 * leave events stored without their score (a retry would then see only duplicates and add nothing).
 * Pass `db` to join an outer transaction.
 */
async function insertAndScore(
  attemptId: string,
  userId: string,
  examSessionId: string | null,
  events: NewEvent[],
  db?: Tx,
) {
  const run = async (tx: Tx) => {
    // Liveness comes from Postgres (never the cache): events after the attempt closed are kept for
    // the timeline with weight 0, and only within a short window after the actual close.
    const [a] = await tx.$queryRaw<{ status: AttemptStatus; closed_at: Date }[]>`
      SELECT a.status, COALESCE(r.graded_at, a.updated_at) AS closed_at
        FROM attempts a LEFT JOIN results r ON r.attempt_id = a.id
       WHERE a.id = ${attemptId}::uuid
         FOR UPDATE OF a`;
    if (!a) throw new AppError('NOT_FOUND', 'Attempt not found.');
    const live = a.status === 'IN_PROGRESS' || a.status === 'SUBMITTING';
    if (!live && Date.now() > a.closed_at.getTime() + LATE_EVENT_WINDOW_MS) {
      throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt no longer accepts events.');
    }
    const inserted = await tx.examEvent.createManyAndReturn({
      data: events.map((e) => ({
        attemptId,
        userId,
        examSessionId,
        type: e.type,
        clientEventId: e.clientEventId,
        clientTimestamp: e.clientTimestamp,
        metadata: e.metadata,
        weight: live ? e.weight : 0,
      })),
      // Retries of the same batch are no-ops thanks to UNIQUE(attempt_id, client_event_id).
      skipDuplicates: true,
      select: { weight: true },
    });

    const added = inserted.reduce((n, e) => n + e.weight, 0);
    if (added > 0) {
      // Atomic increment + flag. A CLEARED attempt re-enters review each time its score crosses
      // another multiple of the threshold, so new evidence after a review is not ignored.
      await tx.$executeRaw`
        UPDATE attempts a
           SET violation_score = a.violation_score + ${added},
               flagged_at = COALESCE(a.flagged_at,
                 CASE WHEN a.violation_score + ${added} >= q.violation_threshold THEN now() END),
               review_status = CASE
                 WHEN a.review_status = 'NONE'::"ReviewStatus"
                      AND a.violation_score + ${added} >= q.violation_threshold
                   THEN 'PENDING'::"ReviewStatus"
                 WHEN a.review_status = 'CLEARED'::"ReviewStatus"
                      AND (a.violation_score + ${added}) / q.violation_threshold > a.violation_score / q.violation_threshold
                   THEN 'PENDING'::"ReviewStatus"
                 ELSE a.review_status END
          FROM quizzes q
         WHERE a.id = ${attemptId}::uuid AND q.id = a.quiz_id`;
    }
    return { received: events.length, stored: inserted.length, duplicates: events.length - inserted.length };
  };
  return db ? run(db) : prisma.$transaction(run);
}

/**
 * Per-attempt storage budget (protects free-tier Postgres from event floods). Reserved atomically
 * (a batch that does not fit is not charged) and refunded for duplicates and failed inserts.
 * Returns a refund function.
 */
async function reserveEventBudget(attemptId: string, count: number): Promise<(n: number) => Promise<void>> {
  const k = keys.attemptEventCount(attemptId);
  let used: number;
  try {
    used = await redis.luReserveBudget(k, count, env.MAX_EVENTS_PER_ATTEMPT, 3 * 24 * 3600);
  } catch {
    // Redis unavailable: exact count from Postgres (rare path), nothing to refund.
    const stored = await prisma.examEvent.count({ where: { attemptId } });
    used = stored + count > env.MAX_EVENTS_PER_ATTEMPT ? -1 : stored + count;
    if (used >= 0) return async () => {};
  }
  if (used < 0) {
    throw new AppError('RATE_LIMITED', 'Event limit for this attempt reached.', { maxEvents: env.MAX_EVENTS_PER_ATTEMPT });
  }
  return async (n: number) => {
    if (n > 0) await redis.decrby(k, n).catch(() => {});
  };
}

export async function recordClientEvents(
  auth: AuthContext,
  attemptId: string,
  examSessionId: string | undefined,
  events: EventItemT[],
) {
  const meta = await getAttemptMeta(attemptId);
  if (meta.userId !== auth.userId) throw new AppError('NOT_FOUND', 'Attempt not found.');


  // Events from a superseded window are still evidence, so they are stored, but we only
  // attach the exam session id when it really belongs to this attempt.
  let sessionId: string | null = null;
  if (examSessionId) {
    if (examSessionId === meta.examSessionId) sessionId = examSessionId;
    else {
      const s = await prisma.examSession.findFirst({ where: { id: examSessionId, attemptId }, select: { id: true } });
      sessionId = s?.id ?? null;
    }
  }

  // Charged last, right before the guarded insert, so no earlier failure can leak budget.
  const refund = await reserveEventBudget(attemptId, events.length);

  try {
    const out = await insertAndScore(
      attemptId,
      auth.userId,
      sessionId,
      events.map((e) => ({
        type: e.type as ExamEventType,
        clientEventId: e.clientEventId,
        clientTimestamp: e.timestamp ? new Date(e.timestamp) : null,
        metadata: e.metadata as Prisma.InputJsonValue | undefined,
        weight: weightOf(e.type as ExamEventType),
      })),
    );
    await refund(out.duplicates);
    return out;
  } catch (err) {
    await refund(events.length);
    throw err;
  }
}

/** Events generated by the server itself (e.g. SESSION_CHANGE on device takeover). */
export async function recordServerEvent(
  attemptId: string,
  userId: string,
  examSessionId: string | null,
  type: ExamEventType,
  clientEventId: string,
  metadata?: Prisma.InputJsonValue,
  db?: Tx,
) {
  return insertAndScore(
    attemptId,
    userId,
    examSessionId,
    [{ type, clientEventId, clientTimestamp: null, metadata: { ...(metadata as object), source: 'server' }, weight: weightOf(type) }],
    db,
  );
}
