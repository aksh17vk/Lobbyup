import { describe, expect, it } from 'vitest';
import { computeAttemptWindow, isPastDeadline, remainingSeconds, withinDeadline } from '../../src/modules/attempts/timer.js';

const at = (iso: string) => new Date(iso);

describe('server-side timer', () => {
  it('expires_at = started_at + duration', () => {
    const now = at('2026-01-01T10:00:00Z');
    const w = computeAttemptWindow(now, 3600, null);
    expect(w.startedAt).toEqual(now);
    expect(w.expiresAt).toEqual(at('2026-01-01T11:00:00Z'));
  });

  it('caps expiry at the quiz closing time for late starters', () => {
    const w = computeAttemptWindow(at('2026-01-01T10:30:00Z'), 3600, at('2026-01-01T11:00:00Z'));
    expect(w.expiresAt).toEqual(at('2026-01-01T11:00:00Z'));
  });

  it('refuses to start once the quiz has closed', () => {
    expect(() => computeAttemptWindow(at('2026-01-01T11:00:00Z'), 3600, at('2026-01-01T11:00:00Z'))).toThrow(/closed/);
  });

  it('rejects invalid durations', () => {
    expect(() => computeAttemptWindow(new Date(), 0, null)).toThrow();
    expect(() => computeAttemptWindow(new Date(), 1.5, null)).toThrow();
  });

  it('computes remaining seconds and never goes negative', () => {
    const exp = at('2026-01-01T11:00:00Z');
    expect(remainingSeconds(at('2026-01-01T10:59:00.500Z'), exp)).toBe(59);
    expect(remainingSeconds(at('2026-01-01T12:00:00Z'), exp)).toBe(0);
  });

  it('applies the grace window exactly', () => {
    const exp = at('2026-01-01T11:00:00Z');
    expect(withinDeadline(at('2026-01-01T11:00:30Z'), exp, 30)).toBe(true);
    expect(withinDeadline(at('2026-01-01T11:00:30.001Z'), exp, 30)).toBe(false);
    expect(isPastDeadline(at('2026-01-01T11:00:31Z'), exp, 30)).toBe(true);
  });
});
