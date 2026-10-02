import type { ExamEventType } from '@prisma/client';

/**
 * Signal weights. A single browser event is NEVER proof of cheating: events only add to a
 * violation score; crossing the quiz's threshold flags the attempt for HUMAN review.
 * Weight 0 = informational (kept for the timeline, does not count).
 */
export const EVENT_WEIGHTS: Record<ExamEventType, number> = {
  TAB_HIDDEN: 1,
  TAB_VISIBLE: 0,
  WINDOW_BLUR: 1,
  WINDOW_FOCUS: 0,
  FULLSCREEN_ENTER: 0,
  FULLSCREEN_EXIT: 1,
  COPY_ATTEMPT: 1,
  PASTE_ATTEMPT: 2,
  RIGHT_CLICK: 0,
  // Network drops are common on campus Wi-Fi; never penalised.
  OFFLINE: 0,
  ONLINE: 0,
  SESSION_CHANGE: 2,
  SUBMIT_ATTEMPT: 0,
};

export const EVENT_TYPES = Object.keys(EVENT_WEIGHTS) as ExamEventType[];

export const weightOf = (t: ExamEventType) => EVENT_WEIGHTS[t];

export const shouldFlag = (score: number, threshold: number) => score >= threshold;
