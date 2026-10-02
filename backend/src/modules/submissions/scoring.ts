import type { QuestionType } from '@prisma/client';

export interface GradableQuestion {
  id: string;
  type: QuestionType;
  pointsCents: number;
  negativeCents: number;
  correctOptionIds: string[];
  acceptedAnswers: string[];
}

export type GradableResponse = { selectedOptionIds: string[] } | { text: string };

export type QuestionOutcome = 'correct' | 'incorrect' | 'unanswered';

export interface QuestionGrade {
  questionId: string;
  outcome: QuestionOutcome;
  pointsCents: number;
}

export interface AttemptGrade {
  perQuestion: QuestionGrade[];
  scoreCents: number;
  maxCents: number;
  /** 0–100, two decimals. Negative totals are clamped to 0 %. */
  percentage: number;
  correct: number;
  incorrect: number;
  unanswered: number;
}

export const normalizeText = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function isAnswered(r: GradableResponse | undefined): r is GradableResponse {
  if (!r) return false;
  if ('selectedOptionIds' in r) return r.selectedOptionIds.length > 0;
  return normalizeText(r.text).length > 0;
}

/** Scoring is computed ONLY on the server from stored answers; client scores are never read. */
export function gradeQuestion(q: GradableQuestion, response: GradableResponse | undefined): QuestionGrade {
  if (!isAnswered(response)) return { questionId: q.id, outcome: 'unanswered', pointsCents: 0 };

  let correct = false;
  if (q.type === 'SHORT_TEXT') {
    if ('text' in response) {
      const given = normalizeText(response.text);
      correct = q.acceptedAnswers.some((a) => normalizeText(a) === given);
    }
  } else if ('selectedOptionIds' in response) {
    const selected = new Set(response.selectedOptionIds);
    const expected = new Set(q.correctOptionIds);
    // SINGLE: exactly the one correct option. MULTIPLE: all-or-nothing exact set match.
    correct = selected.size === expected.size && [...expected].every((id) => selected.has(id));
    if (q.type === 'SINGLE_CHOICE' && selected.size !== 1) correct = false;
  }

  return correct
    ? { questionId: q.id, outcome: 'correct', pointsCents: q.pointsCents }
    : { questionId: q.id, outcome: 'incorrect', pointsCents: -q.negativeCents };
}

export function gradeAttempt(questions: GradableQuestion[], answers: Map<string, GradableResponse>): AttemptGrade {
  const perQuestion = questions.map((q) => gradeQuestion(q, answers.get(q.id)));
  const scoreCents = perQuestion.reduce((n, g) => n + g.pointsCents, 0);
  const maxCents = questions.reduce((n, q) => n + q.pointsCents, 0);
  const pct = maxCents > 0 ? (Math.max(0, scoreCents) / maxCents) * 100 : 0;
  return {
    perQuestion,
    scoreCents,
    maxCents,
    percentage: Math.round(Math.min(100, pct) * 100) / 100,
    correct: perQuestion.filter((g) => g.outcome === 'correct').length,
    incorrect: perQuestion.filter((g) => g.outcome === 'incorrect').length,
    unanswered: perQuestion.filter((g) => g.outcome === 'unanswered').length,
  };
}
