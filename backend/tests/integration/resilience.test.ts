/**
 * Regression tests for the review findings: Redis outages, unstorable data, stale caches,
 * interrupted finalisation, event floods and review-queue behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keys } from '../../src/db/redis.js';
import { flushDirtyAttempts } from '../../src/modules/answers/answer.buffer.js';
import { sweepExpiredAttempts } from '../../src/workers/expiry.worker.js';
import {
  closeApp,
  correctResponses,
  createActiveQuiz,
  examHeaders,
  expireAttempt,
  getApp,
  login,
  prisma,
  redis,
  resetDb,
  startAttempt,
  userClient,
  type Client,
} from '../helpers.js';

describe('resilience & data integrity', () => {
  let admin: Client;

  beforeAll(async () => {
    await resetDb();
    await getApp();
    admin = (await userClient('EXAM_ADMIN')).client;
  });
  afterAll(closeApp);

  describe('Redis outage', () => {
    it('autosave falls back to Postgres; submit waits (503) until the buffer is reachable, then grades everything', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      const correct = await correctResponses(quizId);
      const [q1, q2] = [a.questions.find((q) => q.type === 'SHORT_TEXT')!, a.questions.find((q) => q.type === 'MULTIPLE_CHOICE')!];

      // Saved into the Redis buffer before the outage (not yet flushed).
      const before = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q2.questionId}`,
        headers: h,
        payload: { response: correct.get(q2.questionId), revision: 1 },
      });
      expect(before.json().data.status).toBe('accepted');

      redis.disconnect();
      try {
        const during = await s.inject({
          method: 'PUT',
          url: `/api/v1/attempts/${a.attemptId}/answers/${q1.questionId}`,
          headers: h,
          payload: { response: correct.get(q1.questionId), revision: 1 },
        });
        expect(during.statusCode).toBe(200);
        expect(during.json().data.status).toBe('accepted');
        // Written straight to Postgres.
        expect(await prisma.answer.count({ where: { attemptId: a.attemptId, questionId: q1.questionId } })).toBe(1);

        // Events and reads keep working too.
        const ev = await s.inject({
          method: 'POST',
          url: `/api/v1/attempts/${a.attemptId}/events`,
          headers: h,
          payload: { events: [{ clientEventId: 'outage-1', type: 'TAB_HIDDEN' }] },
        });
        expect(ev.statusCode).toBe(202);
        expect((await s.inject({ method: 'GET', url: `/api/v1/attempts/${a.attemptId}` })).statusCode).toBe(200);

        // q2 lives only in the unreachable buffer, so grading now would lose it → 503, retryable.
        const submit = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
        expect(submit.statusCode).toBe(503);
        expect(await prisma.result.count({ where: { attemptId: a.attemptId } })).toBe(0);
      } finally {
        await redis.connect();
      }

      const retry = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      expect(retry.statusCode).toBe(200);
      // q1 (direct to Postgres during the outage) + q2 (Redis buffer before it) both graded: 1 + 2 points.
      expect(retry.json().data.result.score).toBe(3);
      expect(retry.json().data.status).toBe('SUBMITTED');
    });
  });

  describe('unstorable data', () => {
    it('rejects text Postgres cannot store and normalises odd timestamp offsets', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const url = `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`;
      const h = examHeaders(a.examSessionId);

      const nul = await s.inject({ method: 'PUT', url, headers: h, payload: { response: { text: 'a\u0000b' }, revision: 1 } });
      expect(nul.statusCode).toBe(400);
      const surrogate = await s.inject({ method: 'PUT', url, headers: h, payload: { response: { text: 'x\ud800' }, revision: 1 } });
      expect(surrogate.statusCode).toBe(400);
      const year0 = await s.inject({ method: 'PUT', url, headers: h, payload: { response: { text: 'ok' }, revision: 1, clientSavedAt: '0000-01-01T00:00:00Z' } });
      expect(year0.statusCode).toBe(400);

      const offset = await s.inject({
        method: 'PUT',
        url,
        headers: h,
        payload: { response: { text: 'Paris' }, revision: 2, clientSavedAt: '2026-01-01T00:00:00+16:00' },
      });
      expect(offset.statusCode).toBe(200);
      await flushDirtyAttempts();
      const row = await prisma.answer.findFirstOrThrow({ where: { attemptId: a.attemptId, questionId: q.questionId } });
      expect(row.clientSavedAt!.toISOString()).toBe('2025-12-31T08:00:00.000Z');
    });

    it('one unstorable buffered value is quarantined instead of blocking the whole attempt', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      const correct = await correctResponses(quizId);
      const good = a.questions.find((x) => x.type === 'SINGLE_CHOICE')!;
      const bad = a.questions.find((x) => x.type === 'SHORT_TEXT')!;

      await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${good.questionId}`,
        headers: h,
        payload: { response: correct.get(good.questionId), revision: 1 },
      });
      // Simulate a value that slipped past validation (e.g. older client/server version).
      const poison = JSON.stringify({ r: { text: 'a\u0000' }, c: null, s: new Date().toISOString() });
      await redis.hset(keys.attemptAnswers(a.attemptId), bad.questionId, `7|${poison}`);
      await redis.sadd(keys.attemptChanged(a.attemptId), bad.questionId);
      await redis.sadd(keys.dirtyAttempts(), a.attemptId);

      const flushed = await flushDirtyAttempts();
      expect(flushed.failed).toBe(0);
      expect(await prisma.answer.count({ where: { attemptId: a.attemptId } })).toBe(1);
      expect(await redis.hexists(keys.attemptAnswers(a.attemptId), bad.questionId)).toBe(0);

      const sub = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      expect(sub.statusCode).toBe(200);
      expect(sub.json().data.result.score).toBe(1);
    });
  });

  describe('stale caches', () => {
    it('a takeover whose cache refresh was lost heals itself instead of locking the new device out', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { user, client: laptop } = await userClient('STUDENT');
      const a = await startAttempt(laptop, quizId);
      const phone = await login(user.email);
      const resumed = await phone.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/resume`, payload: {} });
      const newSession = resumed.json().data.examSessionId as string;

      // Simulate the failure mode: Postgres has the new session, Redis still has the old one.
      await redis.hset(keys.attemptMeta(a.attemptId), 'examSessionId', a.examSessionId);

      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const save = await phone.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
        headers: examHeaders(newSession),
        payload: { response: { text: 'Paris' }, revision: 1 },
      });
      expect(save.statusCode).toBe(200);
      expect(await redis.hget(keys.attemptMeta(a.attemptId), 'examSessionId')).toBe(newSession);

      // ...and the superseded device is shut out again.
      const old = await laptop.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
        headers: examHeaders(a.examSessionId),
        payload: { response: { text: 'x' }, revision: 2 },
      });
      expect(old.statusCode).toBe(409);
    });

    it('a stale cache write can never move an attempt back to IN_PROGRESS', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      const meta = await redis.hgetall(keys.attemptMeta(a.attemptId));
      // Replay an old IN_PROGRESS snapshot through the monotonic writer.
      const written = await redis.luWriteMeta(
        keys.attemptMeta(a.attemptId),
        'IN_PROGRESS',
        meta.userId!,
        meta.quizId!,
        meta.expiresAt!,
        meta.quizVersion!,
        meta.examSessionId!,
        meta.qmap!,
        Date.now() + 60_000,
        Number(meta.sessionGen ?? 0),
      );
      expect(written).toBe(0);
      expect(await redis.hget(keys.attemptMeta(a.attemptId), 'status')).toBe('SUBMITTED');
    });
  });

  describe('finalisation', () => {
    it('an expiry interrupted mid-finalisation is recorded as EXPIRED, not as a submission', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await expireAttempt(a.attemptId, 300);
      // State left behind by an expiry that crashed after IN_PROGRESS → SUBMITTING.
      await prisma.attempt.update({
        where: { id: a.attemptId },
        data: { status: 'SUBMITTING', submittedAt: new Date(), updatedAt: new Date(Date.now() - 10 * 60_000) },
      });
      await sweepExpiredAttempts();
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId }, include: { result: true } });
      expect(row.status).toBe('EXPIRED');
      expect(row.result).not.toBeNull();
    });

    it('an interrupted on-time submission is completed as SUBMITTED', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await prisma.attempt.update({
        where: { id: a.attemptId },
        data: { status: 'SUBMITTING', submittedAt: new Date(), updatedAt: new Date(Date.now() - 10 * 60_000) },
      });
      await sweepExpiredAttempts();
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).status).toBe('SUBMITTED');
    });
  });

  describe('anti-cheating events', () => {
    it('caps stored events per attempt', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await redis.set(keys.attemptEventCount(a.attemptId), 2999);
      const r = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/events`,
        headers: examHeaders(a.examSessionId),
        payload: { events: [{ clientEventId: 'c1', type: 'TAB_HIDDEN' }, { clientEventId: 'c2', type: 'TAB_HIDDEN' }] },
      });
      expect(r.statusCode).toBe(429);
    });

    it('events after the attempt closed are stored for the timeline but never score', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      const r = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/events`,
        headers: h,
        payload: { events: [{ clientEventId: 'late-1', type: 'PASTE_ATTEMPT' }] },
      });
      expect(r.statusCode).toBe(202);
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
      expect(row.violationScore).toBe(0);
      expect((await prisma.examEvent.findFirstOrThrow({ where: { attemptId: a.attemptId, clientEventId: 'late-1' } })).weight).toBe(0);
    });

    it('a cleared attempt re-enters review when new signals cross the next threshold multiple', async () => {
      const { quizId } = await createActiveQuiz(admin, { violationThreshold: 2 });
      const { client: s } = await userClient('STUDENT');
      const proctor = (await userClient('PROCTOR')).client;
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      const send = (id: string) =>
        s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/events`, headers: h, payload: { events: [{ clientEventId: id, type: 'TAB_HIDDEN' }] } });

      await send('t1');
      await send('t2');
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).reviewStatus).toBe('PENDING');
      await proctor.inject({ method: 'POST', url: `/api/v1/admin/violations/${a.attemptId}/review`, payload: { decision: 'CLEARED' } });

      await send('t3'); // score 3: same multiple → stays cleared
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).reviewStatus).toBe('CLEARED');
      await send('t4'); // score 4: crosses 2× threshold → back to the queue
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).reviewStatus).toBe('PENDING');
    });
  });
});
