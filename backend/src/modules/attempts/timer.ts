import { AppError } from '../../utils/errors.js';

/**
 * Server-authoritative exam timing. The client receives expiresAt and serverTime
 * only so it can render a countdown; nothing the client sends affects these values.
 */
export function computeAttemptWindow(now: Date, durationSeconds: number, quizEndsAt: Date | null) {
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) throw new Error('invalid duration');
  const byDuration = now.getTime() + durationSeconds * 1000;
  // A late starter never gets time beyond the quiz's closing time.
  const expiresMs = quizEndsAt ? Math.min(byDuration, quizEndsAt.getTime()) : byDuration;
  if (expiresMs <= now.getTime()) throw new AppError('QUIZ_NOT_AVAILABLE', 'This quiz has closed.');
  return { startedAt: now, expiresAt: new Date(expiresMs) };
}

export const remainingSeconds = (now: Date, expiresAt: Date) =>
  Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));

/** True while writes are accepted: until expiresAt plus a small network grace. */
export const withinDeadline = (now: Date, expiresAt: Date, graceSeconds: number) =>
  now.getTime() <= expiresAt.getTime() + graceSeconds * 1000;

/** True once the attempt can no longer accept any write and must be finalised. */
export const isPastDeadline = (now: Date, expiresAt: Date, graceSeconds: number) =>
  !withinDeadline(now, expiresAt, graceSeconds);
