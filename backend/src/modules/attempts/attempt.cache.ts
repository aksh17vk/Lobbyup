import type { AttemptStatus, QuestionType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { getQuizContent } from '../quizzes/quiz.content.js';

/**
 * Hot attempt state kept in a Redis hash so the autosave path needs no Postgres read.
 * Postgres remains authoritative: the hash is rebuilt from it whenever it is missing,
 * and every state transition rewrites it from Postgres.
 */
export interface AttemptMeta {
  attemptId: string;
  userId: string;
  quizId: string;
  status: AttemptStatus;
  expiresAt: number;
  quizVersion: number;
  examSessionId: string;
  /**
   * Number of exam sessions ever opened for the attempt. Assigned under the attempt row lock, so it
   * strictly increases with every takeover and orders cache writes without trusting server clocks.
   */
  sessionGen: number;
  /** questionId → { type, allowed option ids } for validating answers without touching Postgres. */
  qmap: Record<string, { t: QuestionType; o: string[] }>;
}

const KEEP_AFTER_EXPIRY_MS = 24 * 3600_000;

export async function buildAttemptMeta(attemptId: string): Promise<AttemptMeta | null> {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: { select: { questionId: true, optionOrder: true } },
      examSessions: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
      _count: { select: { examSessions: true } },
    },
  });
  if (!attempt) return null;
  const content = await getQuizContent(attempt.quizId, attempt.quizVersion);
  const types = new Map(content.questions.map((q) => [q.id, q.type]));
  const qmap: AttemptMeta['qmap'] = {};
  for (const aq of attempt.questions) qmap[aq.questionId] = { t: types.get(aq.questionId)!, o: aq.optionOrder };

  return {
    attemptId: attempt.id,
    userId: attempt.userId,
    quizId: attempt.quizId,
    status: attempt.status,
    expiresAt: attempt.expiresAt.getTime(),
    quizVersion: attempt.quizVersion,
    examSessionId: attempt.examSessions[0]?.id ?? '',
    sessionGen: attempt._count.examSessions,
    qmap,
  };
}

/** Monotonic write (see WRITE_META in db/redis.ts): never moves status or session generation backwards. */
async function writeMeta(meta: AttemptMeta) {
  await redis.luWriteMeta(
    keys.attemptMeta(meta.attemptId),
    meta.status,
    meta.userId,
    meta.quizId,
    String(meta.expiresAt),
    String(meta.quizVersion),
    meta.examSessionId,
    JSON.stringify(meta.qmap),
    meta.expiresAt + KEEP_AFTER_EXPIRY_MS,
    meta.sessionGen,
  );
}

/**
 * Re-read from Postgres and write the Redis copy. Call after every state change.
 * Throws if Redis is unavailable — finalisation relies on that to avoid grading while
 * the answer buffer is unreachable.
 */
export async function refreshAttemptMeta(attemptId: string): Promise<AttemptMeta> {
  const meta = await buildAttemptMeta(attemptId);
  if (!meta) throw notFound('Attempt');
  await writeMeta(meta);
  return meta;
}

/**
 * Like refreshAttemptMeta, but a Redis failure only logs: Postgres already holds the truth.
 * Failed writes are queued and replayed as soon as Redis reconnects, so a stale cache entry
 * (e.g. from a takeover during an outage) is repaired before it can be trusted for long.
 */
export async function refreshAttemptMetaBestEffort(attemptId: string): Promise<AttemptMeta> {
  const meta = await buildAttemptMeta(attemptId);
  if (!meta) throw notFound('Attempt');
  await writeMeta(meta).catch((err) => {
    pendingRepairs.add(attemptId);
    logger.warn({ err, attemptId }, 'attempt cache refresh failed; queued for repair');
  });
  return meta;
}

const pendingRepairs = new Set<string>();

export function queueCacheRepair(attemptId: string) {
  pendingRepairs.add(attemptId);
}

async function repairPending() {
  for (const id of [...pendingRepairs]) {
    try {
      const meta = await buildAttemptMeta(id);
      if (meta) await writeMeta(meta);
      pendingRepairs.delete(id);
    } catch {
      return; // still unavailable; the next reconnect retries
    }
  }
}
redis.on('ready', () => void repairPending());

/** Redis first; Postgres on miss or when Redis is unavailable. Throws NOT_FOUND for unknown attempts. */
export async function getAttemptMeta(attemptId: string): Promise<AttemptMeta> {
  let h: Record<string, string>;
  try {
    h = await redis.hgetall(keys.attemptMeta(attemptId));
  } catch {
    const meta = await buildAttemptMeta(attemptId);
    if (!meta) throw notFound('Attempt');
    return meta;
  }
  if (h.userId && h.status && h.expiresAt && h.qmap) {
    return {
      attemptId,
      userId: h.userId,
      quizId: h.quizId!,
      status: h.status as AttemptStatus,
      expiresAt: Number(h.expiresAt),
      quizVersion: Number(h.quizVersion),
      examSessionId: h.examSessionId ?? '',
      sessionGen: Number(h.sessionGen ?? 0),
      qmap: JSON.parse(h.qmap),
    };
  }
  return refreshAttemptMetaBestEffort(attemptId);
}
