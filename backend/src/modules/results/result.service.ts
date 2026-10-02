import { prisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import { assertOwnerOr, isSuperAdmin, type AuthContext } from '../permissions/authorize.js';
import { getQuizContent } from '../quizzes/quiz.content.js';

/**
 * Students see their own result according to the quiz's resultsVisibility.
 * Correct answers are revealed to students only after the quiz has ENDED, so they
 * cannot leak to classmates still taking it. Staff with VIEW_ALL_RESULTS see everything.
 */
export async function getResult(auth: AuthContext, attemptId: string) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      result: true,
      quiz: true,
      questions: { orderBy: { displayOrder: 'asc' }, include: { answer: true } },
      user: { select: { id: true, fullName: true, email: true } },
    },
  });
  if (!attempt) throw new AppError('NOT_FOUND', 'Result not found.');
  const access = assertOwnerOr(auth, attempt.userId, 'VIEW_OWN_RESULT', 'VIEW_ALL_RESULTS', 'Result');
  if (!attempt.result) throw new AppError('NOT_FOUND', 'Result not available yet.', { attemptStatus: attempt.status });

  const quizClosed = attempt.quiz.status === 'ENDED' || attempt.quiz.status === 'ARCHIVED';
  if (access === 'owner') {
    const v = attempt.quiz.resultsVisibility;
    const released = v === 'IMMEDIATE' || (v === 'AFTER_END' && quizClosed);
    if (!released) {
      throw new AppError('RESULT_NOT_RELEASED', 'Results for this quiz have not been released yet.', {
        resultsVisibility: v,
      });
    }
  }
  // The answer key (and per-question correctness, which implies it) reaches students only once
  // the quiz is closed AND no attempt can still write — ending a quiz does not cut short attempts
  // already running, so their owners must not be able to obtain the key from a classmate.
  // Quiz owners and super admins always see it; other staff follow the same rule as students.
  const keyHolder = access === 'staff' && (isSuperAdmin(auth) || attempt.quiz.createdById === auth.userId);
  const revealKey = keyHolder || (quizClosed && (await noLiveAttempts(attempt.quizId)));

  const content = await getQuizContent(attempt.quizId, attempt.quizVersion);
  const byId = new Map(content.questions.map((q) => [q.id, q]));
  const r = attempt.result;

  return {
    attemptId: attempt.id,
    quiz: { id: attempt.quiz.id, title: attempt.quiz.title },
    ...(access === 'staff' ? { student: attempt.user } : {}),
    status: attempt.status,
    submittedAt: attempt.submittedAt,
    score: Number(r.score),
    maxScore: Number(r.maxScore),
    percentage: Number(r.percentage),
    passed: r.passed,
    correctCount: r.correctCount,
    incorrectCount: r.incorrectCount,
    unansweredCount: r.unansweredCount,
    gradedAt: r.gradedAt,
    questions: attempt.questions.map((aq) => {
      const q = byId.get(aq.questionId)!;
      const options = new Map(q.options.map((o) => [o.id, o]));
      return {
        displayOrder: aq.displayOrder,
        questionId: q.id,
        type: q.type,
        prompt: q.prompt,
        points: q.pointsCents / 100,
        options: aq.optionOrder.map((id) => ({
          id,
          text: options.get(id)!.text,
          ...(revealKey ? { isCorrect: options.get(id)!.isCorrect } : {}),
        })),
        ...(revealKey && q.type === 'SHORT_TEXT' ? { acceptedAnswers: q.acceptedAnswers } : {}),
        yourResponse: aq.answer?.response ?? null,
        ...(revealKey
          ? {
              isCorrect: aq.answer?.isCorrect ?? false,
              pointsAwarded: aq.answer?.pointsAwarded ? Number(aq.answer.pointsAwarded) : 0,
            }
          : {}),
      };
    }),
  };
}

async function noLiveAttempts(quizId: string) {
  const live = await prisma.attempt.count({ where: { quizId, status: { in: ['IN_PROGRESS', 'SUBMITTING'] } } });
  return live === 0;
}
