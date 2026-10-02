import type { Quiz } from '@prisma/client';
import type { z } from 'zod';
import { prisma, type Tx } from '../../db/prisma.js';
import { audit } from '../../utils/audit.js';
import { AppError, notFound } from '../../utils/errors.js';
import { assertCanManageQuiz, type AuthContext } from '../permissions/authorize.js';
import { isContentEditable } from '../quizzes/quiz.lifecycle.js';
import type { PoolBody } from '../quizzes/quiz.schemas.js';
import type { QuestionInputT } from './question.schemas.js';

/**
 * Every content mutation runs in a transaction that locks the quiz row (so it cannot
 * race with publish), checks ownership + DRAFT status, and bumps contentVersion so
 * cached content is never stale.
 */
async function withEditableQuiz<T>(auth: AuthContext, quizId: string, fn: (tx: Tx, quiz: Quiz) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM quizzes WHERE id = ${quizId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound('Quiz');
    const quiz = await tx.quiz.findUniqueOrThrow({ where: { id: quizId } });
    assertCanManageQuiz(auth, quiz, 'MANAGE_QUESTIONS');
    if (!isContentEditable(quiz.status)) {
      throw new AppError('QUIZ_NOT_EDITABLE', `Questions cannot be changed while the quiz is ${quiz.status}.`);
    }
    const result = await fn(tx, quiz);
    await tx.quiz.update({ where: { id: quizId }, data: { contentVersion: { increment: 1 } } });
    return result;
  });
}

async function assertPoolInQuiz(tx: Tx, poolId: string | null | undefined, quizId: string) {
  if (!poolId) return;
  const pool = await tx.questionPool.findUnique({ where: { id: poolId } });
  if (!pool || pool.quizId !== quizId) throw new AppError('VALIDATION_ERROR', 'poolId does not belong to this quiz.');
}

const questionInclude = { options: { orderBy: { position: 'asc' as const } } };

export async function createQuestions(auth: AuthContext, quizId: string, inputs: QuestionInputT[]) {
  return withEditableQuiz(auth, quizId, async (tx) => {
    const last = await tx.question.aggregate({ where: { quizId }, _max: { position: true } });
    let nextPos = (last._max.position ?? -1) + 1;
    const poolIds = new Set(inputs.map((i) => i.poolId).filter(Boolean));
    for (const p of poolIds) await assertPoolInQuiz(tx, p, quizId);

    const created = [];
    for (const q of inputs) {
      created.push(
        await tx.question.create({
          data: {
            quizId,
            type: q.type,
            prompt: q.prompt,
            points: q.points,
            negativePoints: q.negativePoints,
            poolId: q.poolId ?? null,
            acceptedAnswers: q.acceptedAnswers,
            position: q.position ?? nextPos++,
            options: { create: q.options.map((o, i) => ({ text: o.text, isCorrect: o.isCorrect, position: i })) },
          },
          include: questionInclude,
        }),
      );
    }
    await audit(auth.userId, 'question.create', 'quiz', quizId, { count: created.length }, tx);
    return created;
  });
}

async function questionQuizId(questionId: string) {
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { quizId: true } });
  if (!q) throw notFound('Question');
  return q.quizId;
}

/** Full replacement of a question including its options. */
export async function replaceQuestion(auth: AuthContext, questionId: string, input: QuestionInputT) {
  const quizId = await questionQuizId(questionId);
  return withEditableQuiz(auth, quizId, async (tx) => {
    await assertPoolInQuiz(tx, input.poolId, quizId);
    await tx.questionOption.deleteMany({ where: { questionId } });
    const updated = await tx.question.update({
      where: { id: questionId },
      data: {
        type: input.type,
        prompt: input.prompt,
        points: input.points,
        negativePoints: input.negativePoints,
        poolId: input.poolId ?? null,
        acceptedAnswers: input.acceptedAnswers,
        ...(input.position !== undefined ? { position: input.position } : {}),
        options: { create: input.options.map((o, i) => ({ text: o.text, isCorrect: o.isCorrect, position: i })) },
      },
      include: questionInclude,
    });
    await audit(auth.userId, 'question.update', 'question', questionId, undefined, tx);
    return updated;
  });
}

export async function deleteQuestion(auth: AuthContext, questionId: string) {
  const quizId = await questionQuizId(questionId);
  await withEditableQuiz(auth, quizId, async (tx) => {
    await tx.question.delete({ where: { id: questionId } });
    await audit(auth.userId, 'question.delete', 'question', questionId, { quizId }, tx);
  });
}

// ───────────── Pools ─────────────

export async function createPool(auth: AuthContext, quizId: string, input: z.output<typeof PoolBody>) {
  return withEditableQuiz(auth, quizId, async (tx) => {
    const pool = await tx.questionPool.create({ data: { quizId, ...input } });
    await audit(auth.userId, 'pool.create', 'quiz', quizId, { poolId: pool.id }, tx);
    return pool;
  });
}

async function poolQuizId(poolId: string) {
  const p = await prisma.questionPool.findUnique({ where: { id: poolId }, select: { quizId: true } });
  if (!p) throw notFound('Pool');
  return p.quizId;
}

export async function updatePool(auth: AuthContext, poolId: string, input: z.output<typeof PoolBody>) {
  const quizId = await poolQuizId(poolId);
  return withEditableQuiz(auth, quizId, (tx) => tx.questionPool.update({ where: { id: poolId }, data: input }));
}

export async function deletePool(auth: AuthContext, poolId: string) {
  const quizId = await poolQuizId(poolId);
  // Questions in the pool become unpooled (always delivered), per onDelete: SetNull.
  await withEditableQuiz(auth, quizId, (tx) => tx.questionPool.delete({ where: { id: poolId } }));
}
