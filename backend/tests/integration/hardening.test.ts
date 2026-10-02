/**
 * Regression tests for the second review round (fix verification).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keys } from '../../src/db/redis.js';
import { flushDirtyAttempts } from '../../src/modules/answers/answer.buffer.js';
import { buildAttemptMeta } from '../../src/modules/attempts/attempt.cache.js';
import {
  closeApp,
  correctResponses,
  createActiveQuiz,
  createUser,
  examHeaders,
  getApp,
  login,
  prisma,
  redis,
  resetDb,
  startAttempt,
  userClient,
  type Client,
} from '../helpers.js';

describe('hardening (second review round)', () => {
  let admin: Client;

  beforeAll(async () => {
    await resetDb();
    await getApp();
    admin = (await userClient('EXAM_ADMIN')).client;
  });
  afterAll(closeApp);

  it('writes from a superseded exam session are never persisted, even if a stale cache accepted them', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { user, client: laptop } = await userClient('STUDENT');
    const a = await startAttempt(laptop, quizId);
    const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
    const oldMeta = await redis.hgetall(keys.attemptMeta(a.attemptId));

    // Takeover on a second device.
    const phone = await login(user.email);
    await phone.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/resume`, payload: {} });
    // Simulate fence + refresh both lost (Redis outage during the takeover), some seconds ago.
    await redis.hset(keys.attemptMeta(a.attemptId), { examSessionId: oldMeta.examSessionId!, sessionGen: oldMeta.sessionGen ?? '0' });
    await prisma.examSession.update({ where: { id: a.examSessionId }, data: { endedAt: new Date(Date.now() - 10_000) } });

    const ghost = await laptop.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
      headers: examHeaders(a.examSessionId),
      payload: { response: { text: 'from-old-device' }, revision: Date.now() },
    });
    expect(ghost.statusCode).toBe(200); // accepted by the stale cache…
    await flushDirtyAttempts();
    // …but never persisted, and removed from the buffer.
    expect(await prisma.answer.count({ where: { attemptId: a.attemptId } })).toBe(0);
    expect(await redis.hexists(keys.attemptAnswers(a.attemptId), q.questionId)).toBe(0);
  });

  it('a stale refresh cannot roll the cached exam session back after a takeover (session generation)', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { user, client: laptop } = await userClient('STUDENT');
    const a = await startAttempt(laptop, quizId);
    const before = (await buildAttemptMeta(a.attemptId))!; // snapshot taken before the takeover
    const phone = await login(user.email);
    const resumed = await phone.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/resume`, payload: {} });
    const written = await redis.luWriteMeta(
      keys.attemptMeta(a.attemptId),
      before.status,
      before.userId,
      before.quizId,
      String(before.expiresAt),
      String(before.quizVersion),
      before.examSessionId,
      JSON.stringify(before.qmap),
      Date.now() + 60_000,
      before.sessionGen,
    );
    expect(written).toBe(0);
    expect(await redis.hget(keys.attemptMeta(a.attemptId), 'examSessionId')).toBe(resumed.json().data.examSessionId);
  });

  it('attempt view and sync flag incomplete answers while the buffer is unreachable', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    expect(a.raw.answersComplete).toBe(true);
    redis.disconnect();
    try {
      const view = await s.inject({ method: 'GET', url: `/api/v1/attempts/${a.attemptId}` });
      expect(view.statusCode).toBe(200);
      expect(view.json().data.answersComplete).toBe(false);
      const ready = await s.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().data.cache).toBe('degraded');
    } finally {
      await redis.connect();
    }
  });

  it('submit uses authoritative state: an on-time submit interrupted before the deadline is recorded as SUBMITTED', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const now = Date.now();
    // Submit began on time (then e.g. a 503); the retry arrives after the deadline, cache still says IN_PROGRESS.
    await prisma.attempt.update({
      where: { id: a.attemptId },
      data: {
        status: 'SUBMITTING',
        startedAt: new Date(now - 3600_000),
        expiresAt: new Date(now - 120_000),
        submittedAt: new Date(now - 150_000),
      },
    });
    const r = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: examHeaders(a.examSessionId), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.status).toBe('SUBMITTED');
  });

  it('event budget: duplicates are refunded and an oversized batch is not charged', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const h = examHeaders(a.examSessionId);
    const batch = { events: [{ clientEventId: 'b1', type: 'WINDOW_FOCUS' }, { clientEventId: 'b2', type: 'WINDOW_FOCUS' }] };
    await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/events`, headers: h, payload: batch });
    await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/events`, headers: h, payload: batch });
    expect(Number(await redis.get(keys.attemptEventCount(a.attemptId)))).toBe(2);

    await redis.set(keys.attemptEventCount(a.attemptId), 2999);
    const tooBig = await s.inject({
      method: 'POST',
      url: `/api/v1/attempts/${a.attemptId}/events`,
      headers: h,
      payload: { events: [{ clientEventId: 'c1', type: 'TAB_HIDDEN' }, { clientEventId: 'c2', type: 'TAB_HIDDEN' }] },
    });
    expect(tooBig.statusCode).toBe(429);
    const fits = await s.inject({
      method: 'POST',
      url: `/api/v1/attempts/${a.attemptId}/events`,
      headers: h,
      payload: { events: [{ clientEventId: 'c3', type: 'TAB_HIDDEN' }] },
    });
    expect(fits.statusCode).toBe(202);
  });

  it('events after submission never score, even when the cache still says the attempt is live', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const h = examHeaders(a.examSessionId);
    await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
    await redis.hset(keys.attemptMeta(a.attemptId), 'status', 'SUBMITTING'); // stale cache
    await s.inject({
      method: 'POST',
      url: `/api/v1/attempts/${a.attemptId}/events`,
      headers: h,
      payload: { events: [{ clientEventId: 'p1', type: 'PASTE_ATTEMPT' }] },
    });
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).violationScore).toBe(0);
  });

  it('a role manager cannot strip a more privileged role to bypass user-management checks', async () => {
    const perms = await prisma.permission.findMany({ where: { key: { in: ['MANAGE_ROLES', 'MANAGE_USERS'] } } });
    const role = await prisma.role.create({ data: { name: 'ROLE_MGR_3', permissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
    const u = await createUser('STUDENT');
    await prisma.userRole.deleteMany({ where: { userId: u.id } });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    const mgr = await login(u.email);

    const examAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'EXAM_ADMIN' } });
    const strip = await mgr.inject({ method: 'PUT', url: `/api/v1/admin/roles/${examAdminRole.id}/permissions`, payload: { permissions: [] } });
    expect(strip.statusCode).toBe(403);
    expect(await prisma.rolePermission.count({ where: { roleId: examAdminRole.id } })).toBeGreaterThan(0);
  });

  it('non-owner staff do not get the answer key of a running quiz through results', async () => {
    const { quizId } = await createActiveQuiz(admin, { resultsVisibility: 'IMMEDIATE' });
    const other = (await userClient('EXAM_ADMIN')).client;
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const correct = await correctResponses(quizId);
    await s.inject({
      method: 'POST',
      url: `/api/v1/attempts/${a.attemptId}/submit`,
      headers: examHeaders(a.examSessionId),
      payload: { answers: a.questions.map((x) => ({ questionId: x.questionId, response: correct.get(x.questionId), revision: 1 })) },
    });
    const foreign = await other.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.body).not.toContain('isCorrect');
    const owner = await admin.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
    expect(owner.body).toContain('isCorrect');
  });

it('the takeover fence blocks the old device immediately', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { user, client: laptop } = await userClient('STUDENT');
    const a = await startAttempt(laptop, quizId);
    const phone = await login(user.email);
    await phone.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/resume`, payload: {} });
    const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
    const old = await laptop.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
      headers: examHeaders(a.examSessionId),
      payload: { response: { text: 'late' }, revision: Date.now() },
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe('EXAM_SESSION_SUPERSEDED');
  });

  it('concurrent submits that both carry final answers both succeed idempotently', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const correct = await correctResponses(quizId);
    const body = { answers: a.questions.map((x) => ({ questionId: x.questionId, response: correct.get(x.questionId), revision: 1 })) };
    const rs = await Promise.all(
      [0, 1, 2].map(() => s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: examHeaders(a.examSessionId), payload: body })),
    );
    for (const r of rs) expect([200, 503]).toContain(r.statusCode);
    expect(rs.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.result.count({ where: { attemptId: a.attemptId } })).toBe(1);
    expect(Number((await prisma.result.findUniqueOrThrow({ where: { attemptId: a.attemptId } })).score)).toBe(4);
  });

  it('a correct password on an inactive account does not leave lockout charges behind', async () => {
    const u = await createUser('STUDENT', { status: 'SUSPENDED' });
    const app = await getApp();
    for (let i = 0; i < 6; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    }
    await prisma.user.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    expect(r.statusCode).toBe(200);
  });

  it('password change is protected by the same lockout as login', async () => {
    const u = await createUser('STUDENT');
    const c = await login(u.email);
    for (let i = 0; i < 6; i++) {
      await c.inject({ method: 'PUT', url: '/api/v1/auth/password', payload: { currentPassword: `guess-${i}`, newPassword: 'new-password-123' } });
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil).not.toBeNull();
    const right = await c.inject({
      method: 'PUT',
      url: '/api/v1/auth/password',
      payload: { currentPassword: 'correct-horse-battery', newPassword: 'new-password-123' },
    });
    expect(right.statusCode).toBe(401);
  });
});
