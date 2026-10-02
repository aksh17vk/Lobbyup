import type { Attempt, Prisma, QuizStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { isUniqueViolation, prisma } from '../../db/prisma.js';
import { secureRandom } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import { currentAnswers, saveAnswers } from '../answers/answer.service.js';
import type { SyncAnswerItemT } from '../answers/answer.schemas.js';
import { assertOwnerOr, type AuthContext } from '../permissions/authorize.js';
import { getQuizContent } from '../quizzes/quiz.content.js';
import { assertQuizStartable } from '../quizzes/quiz.lifecycle.js';
import { getQuizOr404, publicQuiz } from '../quizzes/quiz.service.js';
import { assertCurrentExamSession, openExamSession, type ClientInfo } from '../sessions/exam-session.service.js';
import { finalizeAttempt } from '../submissions/submission.service.js';
import { buildAttemptMeta, getAttemptMeta } from './attempt.cache.js';
import { planAttemptQuestions } from './randomize.js';
import { computeAttemptWindow, isPastDeadline, remainingSeconds } from './timer.js';

const LIVE = ['IN_PROGRESS', 'SUBMITTING'] as const;

async function findLiveAttempt(quizId: string, userId: string) {
  return prisma.attempt.findFirst({ where: { quizId, userId, status: { in: [...LIVE] } } });
}

/** Lazily finalise an attempt whose time is up (the worker also sweeps these). */
async function settleIfExpired(attempt: Attempt): Promise<Attempt> {
  if (attempt.status === 'IN_PROGRESS' && isPastDeadline(new Date(), attempt.expiresAt, env.SUBMIT_GRACE_SECONDS)) {
    await finalizeAttempt(attempt.id).catch(() => {});
    return prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }
  return attempt;
}

/**
 * POST /attempts — idempotent. A live attempt is resumed instead of creating another;
 * concurrent starts collapse onto one row via the partial unique index.
 */
export async function startAttempt(auth: AuthContext, quizId: string, client: ClientInfo) {
  const quiz = await getQuizOr404(quizId);
  if (quiz.status === 'DRAFT' || quiz.status === 'ARCHIVED') throw new AppError('NOT_FOUND', 'Quiz not found.');

  let live = await findLiveAttempt(quizId, auth.userId);
  if (live) live = await settleIfExpired(live);
  if (live && (live.status === 'IN_PROGRESS' || live.status === 'SUBMITTING')) {
    return { ...(await resumeExisting(auth, live, client)), created: false };
  }

  const now = new Date();
  assertQuizStartable(quiz, now);

  const previous = await prisma.attempt.count({ where: { quizId, userId: auth.userId } });
  if (previous >= quiz.maxAttempts) {
    throw new AppError('MAX_ATTEMPTS_REACHED', 'You have used all attempts for this quiz.', { maxAttempts: quiz.maxAttempts });
  }

  const content = await getQuizContent(quiz.id, quiz.contentVersion);
  const plan = planAttemptQuestions(content, quiz, secureRandom);
  const { startedAt, expiresAt } = computeAttemptWindow(now, quiz.durationSeconds, quiz.endsAt);

  let attempt: Attempt;
  try {
    attempt = await prisma.$transaction(async (tx) => {
      // Serialise with quiz transitions (which lock the row FOR UPDATE): an attempt can never be
      // created after the quiz has been ended, e.g. after the answer key was released.
      const [q] = await tx.$queryRaw<{ status: QuizStatus; starts_at: Date | null; ends_at: Date | null }[]>`
        SELECT status, starts_at, ends_at FROM quizzes WHERE id = ${quizId}::uuid FOR SHARE`;
      assertQuizStartable({ status: q!.status, startsAt: q!.starts_at, endsAt: q!.ends_at }, new Date());
      const a = await tx.attempt.create({
        data: {
          quizId,
          userId: auth.userId,
          attemptNumber: previous + 1,
          status: 'IN_PROGRESS',
          startedAt,
          expiresAt,
          quizVersion: quiz.contentVersion,
          ipAddress: client.ip,
        },
      });
      await tx.attemptQuestion.createMany({
        data: plan.map((p) => ({ attemptId: a.id, ...p })),
      });
      return a;
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Another request (double click / second tab) created it first: resume that one.
    const winner = await findLiveAttempt(quizId, auth.userId);
    if (!winner) throw new AppError('CONFLICT', 'Attempt could not be started; please retry.');
    return { ...(await resumeExisting(auth, winner, client)), created: false };
  }

  const session = await openExamSession(attempt, auth, client);
  return { view: await buildAttemptView(attempt.id), examSessionId: session.id, tookOver: false, created: true };
}

async function resumeExisting(auth: AuthContext, attempt: Attempt, client: ClientInfo) {
  if (attempt.userId !== auth.userId) throw new AppError('NOT_FOUND', 'Attempt not found.');
  if (attempt.status !== 'IN_PROGRESS') {
    throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt is being submitted.');
  }
  const session = await openExamSession(attempt, auth, client);
  return { view: await buildAttemptView(attempt.id), examSessionId: session.id, tookOver: session.tookOver };
}

/** POST /attempts/:id/resume — re-open on this device (new tab, reload after crash, new laptop). */
export async function resumeAttempt(auth: AuthContext, attemptId: string, client: ClientInfo) {
  let attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.userId !== auth.userId) throw new AppError('NOT_FOUND', 'Attempt not found.');
  attempt = await settleIfExpired(attempt);
  if (attempt.status === 'EXPIRED') throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
  if (attempt.status === 'SUBMITTED') throw new AppError('ATTEMPT_ALREADY_SUBMITTED', 'This attempt has already been submitted.');
  return resumeExisting(auth, attempt, client);
}

/**
 * Student-safe attempt view: questions in this attempt's persisted order, options in this
 * attempt's persisted order, NO correct answers, plus the student's current saved answers.
 */
export async function buildAttemptView(attemptId: string) {
  const attempt = await prisma.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { quiz: true, questions: { orderBy: { displayOrder: 'asc' } }, result: { select: { id: true } } },
  });
  const content = await getQuizContent(attempt.quizId, attempt.quizVersion);
  const byId = new Map(content.questions.map((q) => [q.id, q]));
  const live = attempt.status === 'IN_PROGRESS' || attempt.status === 'SUBMITTING';
  const { answers, complete } = live
    ? await currentAnswers(attemptId)
    : {
        answers: (await prisma.answer.findMany({ where: { attemptId } })).map((a) => ({
          questionId: a.questionId,
          revision: Number(a.revision),
          response: a.response,
          serverSavedAt: a.serverSavedAt.toISOString(),
        })),
        complete: true,
      };

  const now = new Date();
  return {
    attempt: {
      id: attempt.id,
      quizId: attempt.quizId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      submittedAt: attempt.submittedAt,
      serverTime: now,
      remainingSeconds: attempt.status === 'IN_PROGRESS' ? remainingSeconds(now, attempt.expiresAt) : 0,
      hasResult: !!attempt.result,
    },
    quiz: publicQuiz(attempt.quiz),
    questions: attempt.questions.map((aq) => {
      const q = byId.get(aq.questionId)!;
      const optionText = new Map(q.options.map((o) => [o.id, o.text]));
      return {
        questionId: q.id,
        displayOrder: aq.displayOrder,
        type: q.type,
        prompt: q.prompt,
        points: q.pointsCents / 100,
        options: aq.optionOrder.map((id) => ({ id, text: optionText.get(id)! })),
      };
    }),
    answers: answers.map((a) => ({ questionId: a.questionId, response: a.response, revision: a.revision, savedAt: a.serverSavedAt })),
    /** false while the answer buffer is unreachable: keep the local copy, it may be newer. */
    answersComplete: complete,
  };
}

export async function getAttempt(auth: AuthContext, attemptId: string) {
  let attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new AppError('NOT_FOUND', 'Attempt not found.');
  assertOwnerOr(auth, attempt.userId, 'START_EXAM', 'VIEW_ATTEMPTS', 'Attempt');
  attempt = await settleIfExpired(attempt);
  return buildAttemptView(attempt.id);
}

/** POST /attempts/:id/submit — transactional & idempotent. */
export async function submitAttempt(
  auth: AuthContext,
  attemptId: string,
  examSessionId: string | undefined,
  finalAnswers: SyncAnswerItemT[] | undefined,
) {
  // Submission is rare and decisive: read the authoritative state from Postgres, not the cache.
  const meta = await buildAttemptMeta(attemptId);
  if (!meta || meta.userId !== auth.userId) throw new AppError('NOT_FOUND', 'Attempt not found.');

  if (meta.status === 'SUBMITTED') return submittedResponse(attemptId, true);
  if (meta.status === 'EXPIRED') throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
  if (meta.status === 'CANCELLED') throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt was cancelled.');

  if (meta.status === 'IN_PROGRESS' && !isPastDeadline(new Date(), new Date(meta.expiresAt), env.SUBMIT_GRACE_SECONDS)) {
    await assertCurrentExamSession(meta, examSessionId);
    // Final sync: anything the client still holds locally is saved before grading.
    if (finalAnswers?.length) {
      try {
        await saveAnswers(auth, attemptId, examSessionId, finalAnswers);
      } catch (err) {
        // A concurrent submit (double click, timer auto-submit, client retry) may already have
        // closed the attempt: fall through to the idempotent finaliser instead of failing.
        const closedMeanwhile =
          err instanceof AppError &&
          ['ATTEMPT_NOT_IN_PROGRESS', 'ATTEMPT_ALREADY_SUBMITTED', 'ATTEMPT_EXPIRED', 'EXAM_SESSION_SUPERSEDED'].includes(err.code) &&
          (await buildAttemptMeta(attemptId))?.status !== 'IN_PROGRESS';
        if (!closedMeanwhile) throw err;
      }
    }
  }
  // Past the deadline (late answers are ignored) or SUBMITTING (a submit is already in flight):
  // finalisation is idempotent and decides SUBMITTED vs EXPIRED from when it actually began.

  const outcome = await finalizeAttempt(attemptId);
  if (outcome.status === 'EXPIRED') throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
  return submittedResponse(attemptId, outcome.alreadyFinal);
}

async function submittedResponse(attemptId: string, alreadySubmitted: boolean) {
  const attempt = await prisma.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { quiz: { select: { resultsVisibility: true } }, result: true },
  });
  const showResult = attempt.quiz.resultsVisibility === 'IMMEDIATE' && attempt.result;
  return {
    attemptId,
    status: attempt.status,
    submittedAt: attempt.submittedAt,
    alreadySubmitted,
    result: showResult
      ? {
          score: Number(attempt.result!.score),
          maxScore: Number(attempt.result!.maxScore),
          percentage: Number(attempt.result!.percentage),
          passed: attempt.result!.passed,
        }
      : null,
  };
}

export async function syncAttempt(
  auth: AuthContext,
  attemptId: string,
  examSessionId: string | undefined,
  answers: SyncAnswerItemT[],
) {
  const saved = answers.length
    ? await saveAnswers(auth, attemptId, examSessionId, answers)
    : await (async () => {
        const meta = await getAttemptMeta(attemptId);
        if (meta.userId !== auth.userId) throw new AppError('NOT_FOUND', 'Attempt not found.');
        await assertCurrentExamSession(meta, examSessionId);
        const now = new Date();
        return { results: [], serverTime: now.toISOString(), remainingSeconds: remainingSeconds(now, new Date(meta.expiresAt)) };
      })();
  // Return the authoritative server state so the client can reconcile its local copy.
  const current = await currentAnswers(attemptId);
  return {
    ...saved,
    serverAnswers: current.answers.map((a) => ({ questionId: a.questionId, revision: a.revision, response: a.response })),
    answersComplete: current.complete,
  };
}

export function clientInfo(req: { ip: string; headers: Record<string, string | string[] | undefined> }, deviceInfo?: Prisma.InputJsonValue): ClientInfo {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: Array.isArray(ua) ? ua[0] : ua, deviceInfo };
}
