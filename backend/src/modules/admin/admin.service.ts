import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { PageQuery, skipTake } from '../../utils/pagination.js';
import { dropAttemptBuffer } from '../answers/answer.buffer.js';
import { refreshAttemptMetaBestEffort } from '../attempts/attempt.cache.js';
import { assertCanManageQuiz, type AuthContext } from '../permissions/authorize.js';
import { closeExamSessions } from '../sessions/exam-session.service.js';

const AttemptStatusEnum = z.enum(['IN_PROGRESS', 'SUBMITTING', 'SUBMITTED', 'EXPIRED', 'CANCELLED']);

export const AdminAttemptQuery = PageQuery.extend({
  quizId: z.uuid().optional(),
  userId: z.uuid().optional(),
  status: AttemptStatusEnum.optional(),
  flagged: z.enum(['true', 'false']).optional(),
});

export const ViolationQuery = PageQuery.extend({
  quizId: z.uuid().optional(),
  reviewStatus: z.enum(['PENDING', 'CLEARED', 'CONFIRMED']).optional(),
  minScore: z.coerce.number().int().min(0).optional(),
});

export const ReviewBody = z
  .object({ decision: z.enum(['CLEARED', 'CONFIRMED']), notes: z.string().trim().max(5000).optional() })
  .strict();

export const CancelBody = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

export const AdminResultQuery = PageQuery.extend({ quizId: z.uuid().optional(), userId: z.uuid().optional() });

const attemptSummary = {
  id: true,
  quizId: true,
  attemptNumber: true,
  status: true,
  startedAt: true,
  expiresAt: true,
  submittedAt: true,
  violationScore: true,
  flaggedAt: true,
  reviewStatus: true,
  user: { select: { id: true, fullName: true, email: true } },
  quiz: { select: { id: true, title: true } },
  result: { select: { score: true, maxScore: true, percentage: true, passed: true } },
} satisfies Prisma.AttemptSelect;

export async function listAttempts(q: z.output<typeof AdminAttemptQuery>) {
  const where: Prisma.AttemptWhereInput = {
    ...(q.quizId ? { quizId: q.quizId } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.flagged === 'true' ? { flaggedAt: { not: null } } : q.flagged === 'false' ? { flaggedAt: null } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.attempt.findMany({ where, select: attemptSummary, orderBy: { startedAt: 'desc' }, ...skipTake(q) }),
    prisma.attempt.count({ where }),
  ]);
  return { items, total };
}

export async function getAttemptDetail(attemptId: string) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: {
      ...attemptSummary,
      ipAddress: true,
      reviewNotes: true,
      reviewedAt: true,
      reviewedBy: { select: { id: true, fullName: true } },
      examSessions: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, ipAddress: true, userAgent: true, deviceInfo: true, createdAt: true, lastActivityAt: true, endedAt: true },
      },
      _count: { select: { answers: true, questions: true } },
    },
  });
  if (!attempt) throw notFound('Attempt');
  const eventCounts = await prisma.examEvent.groupBy({ by: ['type'], where: { attemptId }, _count: { _all: true } });
  return { ...attempt, eventCounts: Object.fromEntries(eventCounts.map((e) => [e.type, e._count._all])) };
}

export async function listAttemptEvents(attemptId: string, page: z.output<typeof PageQuery>) {
  const exists = await prisma.attempt.count({ where: { id: attemptId } });
  if (!exists) throw notFound('Attempt');
  const [items, total] = await Promise.all([
    prisma.examEvent.findMany({ where: { attemptId }, orderBy: { serverTimestamp: 'asc' }, ...skipTake(page) }),
    prisma.examEvent.count({ where: { attemptId } }),
  ]);
  return { items: items.map((e) => ({ ...e, id: e.id.toString() })), total };
}

export async function listViolations(q: z.output<typeof ViolationQuery>) {
  const where: Prisma.AttemptWhereInput = {
    flaggedAt: { not: null },
    ...(q.quizId ? { quizId: q.quizId } : {}),
    ...(q.reviewStatus ? { reviewStatus: q.reviewStatus } : {}),
    ...(q.minScore !== undefined ? { violationScore: { gte: q.minScore } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.attempt.findMany({
      where,
      select: { ...attemptSummary, reviewNotes: true, reviewedAt: true },
      orderBy: [{ violationScore: 'desc' }, { flaggedAt: 'asc' }],
      ...skipTake(q),
    }),
    prisma.attempt.count({ where }),
  ]);
  const counts = items.length
    ? await prisma.examEvent.groupBy({
        by: ['attemptId', 'type'],
        where: { attemptId: { in: items.map((i) => i.id) }, weight: { gt: 0 } },
        _count: { _all: true },
      })
    : [];
  return {
    items: items.map((a) => ({
      ...a,
      signals: Object.fromEntries(counts.filter((c) => c.attemptId === a.id).map((c) => [c.type, c._count._all])),
    })),
    total,
  };
}

/** Human decision on a flagged attempt. Does not change the score; that is a separate policy call. */
export async function reviewViolation(auth: AuthContext, attemptId: string, input: z.output<typeof ReviewBody>) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { id: true, reviewStatus: true } });
  if (!attempt) throw notFound('Attempt');
  const updated = await prisma.attempt.update({
    where: { id: attemptId },
    data: { reviewStatus: input.decision, reviewNotes: input.notes, reviewedById: auth.userId, reviewedAt: new Date() },
    select: { id: true, reviewStatus: true, reviewNotes: true, reviewedAt: true },
  });
  await audit(auth.userId, 'attempt.review', 'attempt', attemptId, { from: attempt.reviewStatus, to: input.decision });
  return updated;
}

export async function cancelAttempt(auth: AuthContext, attemptId: string, reason: string) {
  const target = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { quiz: { select: { createdById: true } } } });
  if (!target) throw notFound('Attempt');
  // Same ownership rule as every other quiz mutation: exam admins act only on their own quizzes.
  assertCanManageQuiz(auth, target.quiz, 'EDIT_EXAM');
  const changed = await prisma.attempt.updateMany({
    where: { id: attemptId, status: { in: ['IN_PROGRESS', 'SUBMITTING'] } },
    data: { status: 'CANCELLED' },
  });
  if (changed.count === 0) {
    const exists = await prisma.attempt.count({ where: { id: attemptId } });
    if (!exists) throw notFound('Attempt');
    throw new AppError('INVALID_STATE_TRANSITION', 'Only live attempts can be cancelled.');
  }
  await closeExamSessions(attemptId);
  await refreshAttemptMetaBestEffort(attemptId);
  await dropAttemptBuffer(attemptId);
  await audit(auth.userId, 'attempt.cancel', 'attempt', attemptId, { reason });
}

export async function listResults(q: z.output<typeof AdminResultQuery>) {
  const where: Prisma.ResultWhereInput = {
    ...(q.quizId ? { quizId: q.quizId } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
  };
  const [items, total, agg] = await Promise.all([
    prisma.result.findMany({
      where,
      orderBy: { gradedAt: 'desc' },
      ...skipTake(q),
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        quiz: { select: { id: true, title: true } },
        attempt: { select: { status: true, violationScore: true, reviewStatus: true } },
      },
    }),
    prisma.result.count({ where }),
    prisma.result.aggregate({ where, _avg: { percentage: true }, _max: { percentage: true }, _min: { percentage: true } }),
  ]);
  return {
    items: items.map((r) => ({ ...r, score: Number(r.score), maxScore: Number(r.maxScore), percentage: Number(r.percentage) })),
    total,
    stats: {
      averagePercentage: agg._avg.percentage === null ? null : Number(agg._avg.percentage),
      maxPercentage: agg._max.percentage === null ? null : Number(agg._max.percentage),
      minPercentage: agg._min.percentage === null ? null : Number(agg._min.percentage),
    },
  };
}

export async function systemStatus() {
  const [dirty, live, dbOk] = await Promise.all([
    redis.scard(keys.dirtyAttempts()).catch(() => null),
    prisma.attempt.count({ where: { status: { in: ['IN_PROGRESS', 'SUBMITTING'] } } }),
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  ]);
  return {
    database: dbOk ? 'ok' : 'error',
    redis: dirty === null ? 'error' : 'ok',
    answerBufferDirtyAttempts: dirty,
    liveAttempts: live,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}
