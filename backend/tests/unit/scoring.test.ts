import { describe, expect, it } from 'vitest';
import { gradeAttempt, gradeQuestion, normalizeText, type GradableQuestion } from '../../src/modules/submissions/scoring.js';

const single: GradableQuestion = {
  id: 'q1',
  type: 'SINGLE_CHOICE',
  pointsCents: 100,
  negativeCents: 25,
  correctOptionIds: ['a'],
  acceptedAnswers: [],
};
const multi: GradableQuestion = {
  id: 'q2',
  type: 'MULTIPLE_CHOICE',
  pointsCents: 200,
  negativeCents: 0,
  correctOptionIds: ['x', 'z'],
  acceptedAnswers: [],
};
const text: GradableQuestion = {
  id: 'q3',
  type: 'SHORT_TEXT',
  pointsCents: 100,
  negativeCents: 0,
  correctOptionIds: [],
  acceptedAnswers: ['New Delhi'],
};

describe('scoring', () => {
  it('single choice: correct, incorrect (negative marking), unanswered', () => {
    expect(gradeQuestion(single, { selectedOptionIds: ['a'] })).toMatchObject({ outcome: 'correct', pointsCents: 100 });
    expect(gradeQuestion(single, { selectedOptionIds: ['b'] })).toMatchObject({ outcome: 'incorrect', pointsCents: -25 });
    expect(gradeQuestion(single, { selectedOptionIds: [] })).toMatchObject({ outcome: 'unanswered', pointsCents: 0 });
    expect(gradeQuestion(single, undefined)).toMatchObject({ outcome: 'unanswered' });
  });

  it('single choice: selecting several options is never correct', () => {
    expect(gradeQuestion(single, { selectedOptionIds: ['a', 'b'] }).outcome).toBe('incorrect');
  });

  it('multiple choice is all-or-nothing', () => {
    expect(gradeQuestion(multi, { selectedOptionIds: ['z', 'x'] }).outcome).toBe('correct');
    expect(gradeQuestion(multi, { selectedOptionIds: ['x'] }).outcome).toBe('incorrect');
    expect(gradeQuestion(multi, { selectedOptionIds: ['x', 'y', 'z'] }).outcome).toBe('incorrect');
  });

  it('short text is case/space-insensitive', () => {
    expect(gradeQuestion(text, { text: '  new   DELHI ' }).outcome).toBe('correct');
    expect(gradeQuestion(text, { text: 'Delhi' }).outcome).toBe('incorrect');
    expect(gradeQuestion(text, { text: '   ' }).outcome).toBe('unanswered');
    expect(normalizeText('Ｍars')).toBe('mars'); // NFKC full-width
  });

  it('wrong answer type for the question is incorrect, not an error', () => {
    expect(gradeQuestion(text, { selectedOptionIds: ['a'] }).outcome).toBe('incorrect');
    expect(gradeQuestion(single, { text: 'a' }).outcome).toBe('incorrect');
  });

  it('aggregates totals in integer hundredths (no float drift)', () => {
    const qs = Array.from({ length: 100 }, (_, i) => ({ ...single, id: `s${i}` }));
    const answers = new Map(qs.map((q, i) => [q.id, { selectedOptionIds: [i < 60 ? 'a' : 'b'] }]));
    const g = gradeAttempt(qs, answers);
    expect(g.scoreCents).toBe(60 * 100 - 40 * 25); // 50.00 points
    expect(g.maxCents).toBe(10000);
    expect(g.percentage).toBe(50);
    expect(g.correct).toBe(60);
    expect(g.incorrect).toBe(40);
  });

  it('clamps percentage at 0 when negative marking exceeds earned points', () => {
    const g = gradeAttempt([single], new Map([['q1', { selectedOptionIds: ['b'] }]]));
    expect(g.scoreCents).toBe(-25);
    expect(g.percentage).toBe(0);
  });

  it('handles an empty quiz', () => {
    expect(gradeAttempt([], new Map()).percentage).toBe(0);
  });
});
