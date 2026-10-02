import type { QuizStatus } from '@prisma/client';
import { AppError } from '../../utils/errors.js';

export const QUIZ_TRANSITIONS = {
  publish: { from: ['DRAFT'], to: 'PUBLISHED' },
  unpublish: { from: ['PUBLISHED'], to: 'DRAFT' },
  activate: { from: ['PUBLISHED'], to: 'ACTIVE' },
  end: { from: ['ACTIVE'], to: 'ENDED' },
  archive: { from: ['DRAFT', 'ENDED'], to: 'ARCHIVED' },
} as const satisfies Record<string, { from: readonly QuizStatus[]; to: QuizStatus }>;

export type QuizAction = keyof typeof QUIZ_TRANSITIONS;

export function nextQuizStatus(current: QuizStatus, action: QuizAction): QuizStatus {
  const t = QUIZ_TRANSITIONS[action];
  if (!(t.from as readonly QuizStatus[]).includes(current)) {
    throw new AppError('INVALID_STATE_TRANSITION', `Cannot ${action} a quiz in status ${current}.`, {
      from: current,
      action,
      allowedFrom: t.from,
    });
  }
  return t.to;
}

/** Questions, options and pools may only change while nobody can have attempted the quiz. */
export const isContentEditable = (s: QuizStatus) => s === 'DRAFT';

/** Title/description/schedule may be adjusted until the quiz goes live. */
export const isSettingsEditable = (s: QuizStatus) => s === 'DRAFT' || s === 'PUBLISHED';

export interface StartWindow {
  status: QuizStatus;
  startsAt: Date | null;
  endsAt: Date | null;
}

export function assertQuizStartable(q: StartWindow, now: Date) {
  if (q.status !== 'ACTIVE') {
    throw new AppError('QUIZ_NOT_AVAILABLE', 'This quiz is not open for attempts.', { status: q.status });
  }
  if (q.startsAt && now < q.startsAt) {
    throw new AppError('QUIZ_NOT_AVAILABLE', 'This quiz has not started yet.', { startsAt: q.startsAt });
  }
  if (q.endsAt && now >= q.endsAt) {
    throw new AppError('QUIZ_NOT_AVAILABLE', 'This quiz has closed.', { endsAt: q.endsAt });
  }
}
