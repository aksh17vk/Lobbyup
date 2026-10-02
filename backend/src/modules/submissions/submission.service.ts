import type { AttemptStatus, Result } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { AppError } from '../../utils/errors.js';
import { fromCents } from '../../utils/money.js';
import { dropAttemptBuffer, flushAttemptBuffer } from '../answers/answer.buffer.js';
import type { AnswerResponseT } from '../answers/answer.schemas.js';
import { refreshAttemptMeta } from '../attempts/attempt.cache.js';
import { withinDeadline } from '../attempts/timer.js';
import { getQuizContent } from '../quizzes/quiz.content.js';
import { closeExamSessions } from '../sessions/exam-session.service.js';
import { gradeAttempt, type GradableQuestion } from './scoring.js';

export interface FinalizeOutcome {
  status: AttemptStatus;
  result: Result | null;
  alreadyFinal: boolean;
}

const FINAL: AttemptStatus[] = ['SUBMITTED', 'EXPIRED'];

/**
 * Finalise an attempt exactly once (manual submit or timer expiry).
 *
 *  1. IN_PROGRESS → SUBMITTING (conditional UPDATE) and refresh the Redis state; from this
 *     instant the atomic save script rejects new answers.
 *  2. Drain this attempt's Redis answer buffer into Postgres (idempotent upserts).
 *  3. One transaction: lock the attempt row (FOR UPDATE), re-check state, grade from the
 *     stored answers, write per-answer marks + the Result row, set SUBMITTED/EXPIRED.
 *
 * The final status is decided inside the locked transaction from WHEN finalisation began
 * (submitted_at, stamped at step 1), not from the caller: began within expires_at + grace →
 * SUBMITTED, later → EXPIRED. An interrupted expiry can therefore never be recorded as a
 * student submission, and a late submit can never beat an expiry to SUBMITTED.
 *
 * Repeating the call (double click, retry, worker + user racing) returns the existing
 * result; UNIQUE(results.attempt_id) is the final backstop against duplicate results.
 * If step 2 fails (Redis down) we abort WITHOUT grading so buffered answers are never lost;
 * the client or the expiry worker retries.
 */
export async function finalizeAttempt(attemptId: string): Promise<FinalizeOutcome> {
  await prisma.attempt.updateMany({
    where: { id: attemptId, status: 'IN_PROGRESS' },
    data: { status: 'SUBMITTING', submittedAt: new Date() },
  });
  try {
    await refreshAttemptMeta(attemptId);
    await flushAttemptBuffer(attemptId);
  } catch (err) {
    // In direct mode nothing is buffered in Redis, so a Redis outage must not block submission.
    if (env.ANSWER_BUFFER === 'direct') {
      logger.warn({ err, attemptId }, 'redis unavailable during finalisation (direct mode); continuing');
    } else {
      logger.error({ err, attemptId }, 'could not drain answer buffer; finalisation postponed');
      throw new AppError('SERVICE_UNAVAILABLE', 'Submission is temporarily unavailable. Your answers are safe; please retry.');
    }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // A duplicate finaliser waits briefly for the lock, then fails fast with a retryable 503
    // instead of holding a pool connection for the whole transaction timeout.
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    const rows = await tx.$queryRaw<
      { status: AttemptStatus; quiz_id: string; quiz_version: number; user_id: string; expires_at: Date; submitted_at: Date | null; updated_at: Date }[]
    >`
      SELECT status, quiz_id, quiz_version, user_id, expires_at, submitted_at, updated_at
        FROM attempts WHERE id = ${attemptId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'Attempt not found.');

    if (FINAL.includes(row.status)) {
      return { status: row.status, result: await tx.result.findUnique({ where: { attemptId } }), alreadyFinal: true };
    }
    if (row.status !== 'SUBMITTING') {
      throw new AppError('ATTEMPT_NOT_IN_PROGRESS', `Attempt is ${row.status} and cannot be submitted.`);
    }

    const [quiz, attemptQuestions, answers] = await Promise.all([
      tx.quiz.findUniqueOrThrow({ where: { id: row.quiz_id }, select: { passingPercentage: true } }),
      tx.attemptQuestion.findMany({ where: { attemptId }, select: { questionId: true } }),
      tx.answer.findMany({ where: { attemptId }, select: { questionId: true, response: true } }),
    ]);
    const content = await getQuizContent(row.quiz_id, row.quiz_version);
    const byId = new Map(content.questions.map((q) => [q.id, q]));
    const gradable: GradableQuestion[] = attemptQuestions.map(({ questionId }) => {
      const q = byId.get(questionId)!;
      return {
        id: q.id,
        type: q.type,
        pointsCents: q.pointsCents,
        negativeCents: q.negativeCents,
        correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id),
        acceptedAnswers: q.acceptedAnswers,
      };
    });
    const grade = gradeAttempt(gradable, new Map(answers.map((a) => [a.questionId, a.response as AnswerResponseT])));

    const answered = new Set(answers.map((a) => a.questionId));
    const graded = grade.perQuestion.filter((g) => answered.has(g.questionId));
    if (graded.length) {
      await tx.$executeRaw`
        UPDATE answers a
           SET is_correct = v.is_correct, points_awarded = v.points
          FROM unnest(
            ${graded.map((g) => g.questionId)}::uuid[],
            ${graded.map((g) => g.outcome === 'correct')}::boolean[],
            ${graded.map((g) => fromCents(g.pointsCents))}::numeric[]
          ) AS v(question_id, is_correct, points)
         WHERE a.attempt_id = ${attemptId}::uuid AND a.question_id = v.question_id`;
    }

    const passing = quiz.passingPercentage === null ? null : Number(quiz.passingPercentage);
    const result = await tx.result.create({
      data: {
        attemptId,
        userId: row.user_id,
        quizId: row.quiz_id,
        score: fromCents(grade.scoreCents),
        maxScore: fromCents(grade.maxCents),
        percentage: grade.percentage,
        passed: passing === null ? null : grade.percentage >= passing,
        correctCount: grade.correct,
        incorrectCount: grade.incorrect,
        unansweredCount: grade.unanswered,
      },
    });
    // updated_at is when the row moved to SUBMITTING if an older build did not stamp submitted_at.
    const began = row.submitted_at ?? row.updated_at;
    const finalStatus: AttemptStatus = withinDeadline(began, row.expires_at, env.SUBMIT_GRACE_SECONDS) ? 'SUBMITTED' : 'EXPIRED';
    await tx.attempt.update({ where: { id: attemptId }, data: { status: finalStatus, submittedAt: began } });
    return { status: finalStatus, result, alreadyFinal: false };
  });

  if (!outcome.alreadyFinal) {
    await closeExamSessions(attemptId).catch(() => {});
  }
  await refreshAttemptMeta(attemptId).catch(() => {});
  await dropAttemptBuffer(attemptId);
  return outcome;
}

const pending = new Set<string>();

/** Fire-and-forget finalisation when an expired attempt is noticed on a request path. */
export function scheduleFinalize(attemptId: string) {
  if (pending.has(attemptId)) return;
  pending.add(attemptId);
  setImmediate(() => {
    finalizeAttempt(attemptId)
      .catch((err) => logger.warn({ err, attemptId }, 'deferred finalisation failed; worker will retry'))
      .finally(() => pending.delete(attemptId));
  });
}
