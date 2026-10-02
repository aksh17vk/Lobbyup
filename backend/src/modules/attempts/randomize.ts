import { sample, shuffle, type Rng } from '../../utils/shuffle.js';
import type { QuizContent } from '../quizzes/quiz.content.js';

export interface AttemptQuestionPlan {
  questionId: string;
  displayOrder: number;
  optionOrder: string[];
}

/**
 * Builds the per-attempt question set. The result is persisted (attempt_questions)
 * so reloads, other devices and grading all see the same mapping.
 *
 *  - Unpooled questions are always included.
 *  - Each pool contributes `drawCount` randomly chosen questions.
 *  - Question order is shuffled, or follows authoring position when shuffling is off.
 *  - Choice options are shuffled per attempt when enabled.
 */
export function planAttemptQuestions(
  content: QuizContent,
  opts: { shuffleQuestions: boolean; shuffleOptions: boolean },
  rng: Rng,
): AttemptQuestionPlan[] {
  const selected = content.questions.filter((q) => !q.poolId);
  for (const pool of content.pools) {
    selected.push(...sample(content.questions.filter((q) => q.poolId === pool.id), pool.drawCount, rng));
  }

  const ordered = opts.shuffleQuestions ? shuffle(selected, rng) : selected.sort((a, b) => a.position - b.position);

  return ordered.map((q, i) => {
    const optionIds = q.options.slice().sort((a, b) => a.position - b.position).map((o) => o.id);
    return {
      questionId: q.id,
      displayOrder: i + 1,
      optionOrder: opts.shuffleOptions && q.type !== 'SHORT_TEXT' ? shuffle(optionIds, rng) : optionIds,
    };
  });
}
