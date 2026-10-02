import { describe, expect, it } from 'vitest';
import { planAttemptQuestions } from '../../src/modules/attempts/randomize.js';
import type { QuizContent } from '../../src/modules/quizzes/quiz.content.js';
import { validateForPublish } from '../../src/modules/quizzes/quiz.content.js';
import { assertQuizStartable, nextQuizStatus } from '../../src/modules/quizzes/quiz.lifecycle.js';

describe('quiz lifecycle', () => {
  it('allows only the defined transitions', () => {
    expect(nextQuizStatus('DRAFT', 'publish')).toBe('PUBLISHED');
    expect(nextQuizStatus('PUBLISHED', 'activate')).toBe('ACTIVE');
    expect(nextQuizStatus('ACTIVE', 'end')).toBe('ENDED');
    expect(nextQuizStatus('ENDED', 'archive')).toBe('ARCHIVED');
    expect(nextQuizStatus('PUBLISHED', 'unpublish')).toBe('DRAFT');
    expect(() => nextQuizStatus('DRAFT', 'activate')).toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    expect(() => nextQuizStatus('ACTIVE', 'publish')).toThrow();
    expect(() => nextQuizStatus('ARCHIVED', 'end')).toThrow();
  });

  it('attempts can start only while ACTIVE and inside the window', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    expect(() => assertQuizStartable({ status: 'PUBLISHED', startsAt: null, endsAt: null }, now)).toThrow();
    expect(() => assertQuizStartable({ status: 'ACTIVE', startsAt: new Date('2026-01-01T11:00:00Z'), endsAt: null }, now)).toThrow(/not started/);
    expect(() => assertQuizStartable({ status: 'ACTIVE', startsAt: null, endsAt: new Date('2026-01-01T09:00:00Z') }, now)).toThrow(/closed/);
    expect(() => assertQuizStartable({ status: 'ACTIVE', startsAt: null, endsAt: null }, now)).not.toThrow();
  });
});

function content(): QuizContent {
  const q = (id: string, position: number, poolId: string | null = null) => ({
    id,
    type: 'SINGLE_CHOICE' as const,
    prompt: id,
    pointsCents: 100,
    negativeCents: 0,
    acceptedAnswers: [],
    poolId,
    position,
    options: ['a', 'b', 'c', 'd'].map((o, i) => ({ id: `${id}-${o}`, text: o, isCorrect: i === 0, position: i })),
  });
  return {
    quizId: 'quiz',
    version: 1,
    pools: [{ id: 'pool', name: 'P', drawCount: 2 }],
    questions: [q('fixed1', 0), q('fixed2', 1), q('p1', 2, 'pool'), q('p2', 3, 'pool'), q('p3', 4, 'pool'), q('p4', 5, 'pool')],
  };
}

/** Deterministic RNG for repeatable tests. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

describe('question randomisation & pools', () => {
  it('includes unpooled questions plus drawCount from each pool', () => {
    const plan = planAttemptQuestions(content(), { shuffleQuestions: true, shuffleOptions: true }, seeded(1));
    const ids = plan.map((p) => p.questionId);
    expect(ids).toHaveLength(4);
    expect(ids).toContain('fixed1');
    expect(ids).toContain('fixed2');
    expect(ids.filter((i) => i.startsWith('p'))).toHaveLength(2);
    expect(plan.map((p) => p.displayOrder)).toEqual([1, 2, 3, 4]);
  });

  it('option order is a permutation of the question’s options', () => {
    const plan = planAttemptQuestions(content(), { shuffleQuestions: true, shuffleOptions: true }, seeded(7));
    for (const p of plan) expect([...p.optionOrder].sort()).toEqual(['a', 'b', 'c', 'd'].map((o) => `${p.questionId}-${o}`));
  });

  it('keeps authoring order when shuffling is disabled', () => {
    const c = content();
    c.pools = [];
    c.questions = c.questions.map((q) => ({ ...q, poolId: null }));
    const plan = planAttemptQuestions(c, { shuffleQuestions: false, shuffleOptions: false }, seeded(3));
    expect(plan.map((p) => p.questionId)).toEqual(['fixed1', 'fixed2', 'p1', 'p2', 'p3', 'p4']);
    expect(plan[0]!.optionOrder).toEqual(['fixed1-a', 'fixed1-b', 'fixed1-c', 'fixed1-d']);
  });

  it('different attempts get different orders', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) =>
        planAttemptQuestions(content(), { shuffleQuestions: true, shuffleOptions: true }, seeded(i + 100))
          .map((p) => p.questionId)
          .join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(5);
  });

  it('publish validation catches undersized pools and malformed questions', () => {
    const c = content();
    c.pools[0]!.drawCount = 10;
    c.questions[0]!.options = c.questions[0]!.options.map((o) => ({ ...o, isCorrect: false }));
    const problems = validateForPublish(c);
    expect(problems.some((p) => p.includes('Pool'))).toBe(true);
    expect(problems.some((p) => p.includes('exactly one correct'))).toBe(true);
    expect(validateForPublish({ ...c, questions: [], pools: [] })).toContain('Quiz has no questions.');
  });
});
