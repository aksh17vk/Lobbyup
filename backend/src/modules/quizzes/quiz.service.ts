import { Prisma, type Quiz, type QuizStatus } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { audit } from '../../utils/audit.js';
import { AppError, forbidden, notFound } from '../../utils/errors.js';
import { skipTake } from '../../utils/pagination.js';
import { assertCanManageQuiz, isSuperAdmin, type AuthContext } from '../permissions/authorize.js';
import { getQuizContent, totalMarksCents, validateForPublish } from './quiz.content.js';
import { fromCents, toCents } from '../../utils/money.js';
import { isContentEditable, isSettingsEditable, nextQuizStatus, type QuizAction } from './quiz.lifecycle.js';
import type { AdminQuizListQuery, CreateQuizBody, UpdateQuizBody } from './quiz.schemas.js';

const STUDENT_LIST_CACHE_KEY = 'lu:quizzes:student-list';
const STUDENT_LIST_TTL = 10;

export async function invalidateStudentQuizList() {
  await redis.del(STUDENT_LIST_CACHE_KEY).catch(() => {});
}

export async function getQuizOr404(quizId: string): Promise<Quiz> {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz) throw notFound('Quiz');
  return quiz;
}

/** Quiz fields safe to show a student (no content, no correct answers). */
export function publicQuiz(q: Quiz, questionCount?: number) {
  return {
    id: q.id,
    title: q.title,
    description: q.description,
    instructions: q.instructions,
    status: q.status,
    durationSeconds: q.durationSeconds,
    startsAt: q.startsAt,
    endsAt: q.endsAt,
    maxAttempts: q.maxAttempts,
    totalMarks: q.totalMarks === null ? null : Number(q.totalMarks),
    passingMarks: q.passingMarks === null ? null : Number(q.passingMarks),
    resultsVisibility: q.resultsVisibility,
    ...(questionCount !== undefined ? { questionCount } : {}),
  };
}

/** Number of questions each attempt will receive (pools draw a subset). */
export async function deliveredQuestionCount(quiz: Quiz) {
  const content = await getQuizContent(quiz.id, quiz.contentVersion);
  const unpooled = content.questions.filter((q) => !q.poolId).length;
  return unpooled + content.pools.reduce((n, p) => n + p.drawCount, 0);
}

// ───────────────────────────── Student-facing ─────────────────────────────

export async function listQuizzesForStudent(userId: string) {
  let quizzes: ReturnType<typeof publicQuiz>[] | null = null;
  try {
    const raw = await redis.get(STUDENT_LIST_CACHE_KEY);
    if (raw) quizzes = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  if (!quizzes) {
    const rows = await prisma.quiz.findMany({
      where: { status: { in: ['PUBLISHED', 'ACTIVE', 'ENDED'] } },
      orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    quizzes = await Promise.all(rows.map(async (q) => publicQuiz(q, await deliveredQuestionCount(q))));
    redis.set(STUDENT_LIST_CACHE_KEY, JSON.stringify(quizzes), 'EX', STUDENT_LIST_TTL).catch(() => {});
  }

  const attempts = await prisma.attempt.findMany({
    where: { userId, quizId: { in: quizzes.map((q) => q.id) } },
    select: { id: true, quizId: true, status: true },
  });
  return quizzes.map((q) => {
    const mine = attempts.filter((a) => a.quizId === q.id);
    const live = mine.find((a) => a.status === 'IN_PROGRESS' || a.status === 'SUBMITTING');
    return { ...q, myAttempts: { count: mine.length, liveAttemptId: live?.id ?? null } };
  });
}

export async function getQuizForStudent(quizId: string, userId: string) {
  const quiz = await getQuizOr404(quizId);
  if (quiz.status === 'DRAFT' || quiz.status === 'ARCHIVED') throw notFound('Quiz');
  const attempts = await prisma.attempt.findMany({
    where: { quizId, userId },
    select: { id: true, status: true, attemptNumber: true, startedAt: true, submittedAt: true },
    orderBy: { attemptNumber: 'asc' },
  });
  return { ...publicQuiz(quiz, await deliveredQuestionCount(quiz)), myAttempts: attempts };
}

// ───────────────────────────── Admin ─────────────────────────────

export async function createQuiz(auth: AuthContext, input: z.output<typeof CreateQuizBody>) {
  const quiz = await prisma.quiz.create({
    data: {
      ...input,
      passingPercentage: input.passingPercentage ?? null,
      passingMarks: input.passingMarks ?? null,
      createdById: auth.userId,
    },
  });
  await audit(auth.userId, 'quiz.create', 'quiz', quiz.id);
  return quiz;
}

export async function listQuizzesAdmin(auth: AuthContext, q: z.output<typeof AdminQuizListQuery>) {
  const where: Prisma.QuizWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.mine === 'true' ? { createdById: auth.userId } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.quiz.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...skipTake(q),
      include: { _count: { select: { questions: true, attempts: true } }, createdBy: { select: { id: true, fullName: true } } },
    }),
    prisma.quiz.count({ where }),
  ]);
  return { items, total };
}

/** Full admin view including the answer key: quiz owner or super admin only. */
export async function getQuizAdmin(auth: AuthContext, quizId: string) {
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: {
      pools: { orderBy: { name: 'asc' } },
      questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } },
      createdBy: { select: { id: true, fullName: true, email: true } },
      _count: { select: { attempts: true } },
    },
  });
  if (!quiz) throw notFound('Quiz');
  if (!isSuperAdmin(auth) && quiz.createdById !== auth.userId) {
    throw forbidden('Only the quiz owner or a super admin can view its questions.');
  }
  return quiz;
}

export async function updateQuiz(auth: AuthContext, quizId: string, input: z.output<typeof UpdateQuizBody>) {
  // Row-locked so a concurrent publish cannot slip a total in between the check and the write.
  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM quizzes WHERE id = ${quizId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound('Quiz');
    const quiz = await tx.quiz.findUniqueOrThrow({ where: { id: quizId } });
    assertCanManageQuiz(auth, quiz, 'EDIT_EXAM');
    if (!isSettingsEditable(quiz.status)) {
      throw new AppError('QUIZ_NOT_EDITABLE', `A quiz in status ${quiz.status} cannot be edited.`);
    }
    // Fields that change how attempts are generated/graded are frozen once published.
    const contentFields = ['durationSeconds', 'shuffleQuestions', 'shuffleOptions', 'maxAttempts'] as const;
    if (!isContentEditable(quiz.status) && contentFields.some((f) => input[f] !== undefined)) {
      throw new AppError('QUIZ_NOT_EDITABLE', 'Unpublish the quiz to change duration, shuffling or attempts.');
    }
    if (input.passingMarks != null && quiz.status !== 'DRAFT') {
      // DRAFT is re-checked at publish; otherwise compare with the real total (computed if missing).
      const totalCents = await quizTotalCents(quiz);
      if (toCents(input.passingMarks) > totalCents) {
        throw new AppError('VALIDATION_ERROR', `passingMarks cannot exceed the quiz total (${fromCents(totalCents)}).`);
      }
    }
    const startsAt = input.startsAt !== undefined ? input.startsAt : quiz.startsAt;
    const endsAt = input.endsAt !== undefined ? input.endsAt : quiz.endsAt;
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new AppError('VALIDATION_ERROR', 'endsAt must be after startsAt.');
    }

    const result = await tx.quiz.update({ where: { id: quizId }, data: input });
    await audit(auth.userId, 'quiz.update', 'quiz', quizId, { fields: Object.keys(input) }, tx);
    return result;
  });
  await invalidateStudentQuizList();
  return updated;
}

/** Total marks of a quiz: the stored value, or computed from its content if not stored yet. */
async function quizTotalCents(quiz: Quiz): Promise<number> {
  if (quiz.totalMarks !== null) return toCents(quiz.totalMarks);
  return totalMarksCents(await getQuizContent(quiz.id, quiz.contentVersion));
}

export async function deleteQuiz(auth: AuthContext, quizId: string) {
  const quiz = await getQuizOr404(quizId);
  assertCanManageQuiz(auth, quiz, 'DELETE_EXAM');
  if (quiz.status !== 'DRAFT') throw new AppError('QUIZ_NOT_EDITABLE', 'Only DRAFT quizzes can be deleted. Archive it instead.');
  const attempts = await prisma.attempt.count({ where: { quizId } });
  if (attempts > 0) throw new AppError('CONFLICT', 'Quiz has attempts and cannot be deleted.');
  await prisma.quiz.delete({ where: { id: quizId } });
  await audit(auth.userId, 'quiz.delete', 'quiz', quizId, { title: quiz.title });
}

export async function transitionQuiz(auth: AuthContext, quizId: string, action: QuizAction) {
  // Row lock so two admins clicking at once cannot produce an inconsistent transition.
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: QuizStatus; created_by_id: string }[]>`
      SELECT id, status, created_by_id FROM quizzes WHERE id = ${quizId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw notFound('Quiz');
    assertCanManageQuiz(auth, { createdById: row.created_by_id }, 'PUBLISH_EXAM');

    const to = nextQuizStatus(row.status, action);
    const data: Prisma.QuizUpdateInput = { status: to };

    if (action === 'publish') {
      const quiz = await tx.quiz.findUniqueOrThrow({ where: { id: quizId } });
      const content = await getQuizContent(quizId, quiz.contentVersion);
      const problems = validateForPublish(content);
      const total = totalMarksCents(content);
      if (quiz.passingMarks !== null && toCents(quiz.passingMarks) > total) {
        problems.push(`Passing marks (${Number(quiz.passingMarks)}) exceed total marks (${fromCents(total)}).`);
      }
      if (problems.length) throw new AppError('VALIDATION_ERROR', 'Quiz is not ready to publish.', problems);
      data.publishedAt = new Date();
      data.totalMarks = fromCents(total);
    }
    if (action === 'activate') {
      // Quizzes published before total_marks existed (or inserted directly) get it now.
      const quiz = await tx.quiz.findUniqueOrThrow({ where: { id: quizId } });
      const total = await quizTotalCents(quiz);
      if (quiz.passingMarks !== null && toCents(quiz.passingMarks) > total) {
        throw new AppError('VALIDATION_ERROR', `Passing marks (${Number(quiz.passingMarks)}) exceed total marks (${fromCents(total)}).`);
      }
      if (quiz.totalMarks === null) data.totalMarks = fromCents(total);
    }
    if (action === 'unpublish') {
      const attempts = await tx.attempt.count({ where: { quizId } });
      if (attempts > 0) throw new AppError('CONFLICT', 'Quiz already has attempts and cannot be unpublished.');
      data.publishedAt = null;
      data.totalMarks = null; // recomputed at the next publish
    }

    const updated = await tx.quiz.update({ where: { id: quizId }, data });
    await audit(auth.userId, `quiz.${action}`, 'quiz', quizId, { from: row.status, to }, tx);
    return updated;
  }).finally(invalidateStudentQuizList);
}
