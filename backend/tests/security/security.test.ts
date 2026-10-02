/**
 * PRD §23 security cases. Every one must be rejected, and must leave data untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consume } from '../../src/middleware/rate-limit.js';
import {
  closeApp,
  correctResponses,
  createActiveQuiz,
  examHeaders,
  expireAttempt,
  getApp,
  prisma,
  resetDb,
  startAttempt,
  userClient,
  type Client,
} from '../helpers.js';

describe('security', () => {
  let admin: Client;
  let studentA: Client;
  let studentB: Client;
  let quizId: string;

  beforeAll(async () => {
    await resetDb();
    await getApp();
    admin = (await userClient('EXAM_ADMIN')).client;
    studentA = (await userClient('STUDENT')).client;
    studentB = (await userClient('STUDENT')).client;
    ({ quizId } = await createActiveQuiz(admin, { maxAttempts: 3 }));
  });
  afterAll(closeApp);

  describe('Student → Admin API', () => {
    const adminCalls: [string, string, object?][] = [
      ['GET', '/api/v1/admin/quizzes'],
      ['POST', '/api/v1/admin/quizzes', { title: 'x', durationSeconds: 300 }],
      ['GET', '/api/v1/admin/attempts'],
      ['GET', '/api/v1/admin/violations'],
      ['GET', '/api/v1/admin/results'],
      ['GET', '/api/v1/admin/users'],
      ['GET', '/api/v1/admin/roles'],
      ['GET', '/api/v1/admin/system/status'],
    ];
    it.each(adminCalls)('%s %s → 403', async (method, url, payload) => {
      const r = await studentA.inject({ method, url, payload });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    });

    it('state transitions are denied', async () => {
      const r = await studentA.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/end` });
      expect(r.statusCode).toBe(403);
      expect((await prisma.quiz.findUniqueOrThrow({ where: { id: quizId } })).status).toBe('ACTIVE');
    });

    it('unauthenticated → 401', async () => {
      const app = await getApp();
      const r = await app.inject({ method: 'GET', url: '/api/v1/admin/quizzes' });
      expect(r.statusCode).toBe(401);
    });

    it('proctor cannot edit quizzes or manage users', async () => {
      const proctor = (await userClient('PROCTOR')).client;
      expect((await proctor.inject({ method: 'PUT', url: `/api/v1/admin/quizzes/${quizId}`, payload: { title: 'x' } })).statusCode).toBe(403);
      expect((await proctor.inject({ method: 'GET', url: '/api/v1/admin/users' })).statusCode).toBe(403);
    });
  });

  describe('Student A → Student B attempt', () => {
    let bAttempt: Awaited<ReturnType<typeof startAttempt>>;
    beforeAll(async () => {
      bAttempt = await startAttempt(studentB, quizId);
    });

    it('cannot read it', async () => {
      const r = await studentA.inject({ method: 'GET', url: `/api/v1/attempts/${bAttempt.attemptId}` });
      expect(r.statusCode).toBe(404); // indistinguishable from a non-existent id
    });

    it('cannot save answers into it, even with B’s exam session id', async () => {
      const q = bAttempt.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const r = await studentA.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${bAttempt.attemptId}/answers/${q.questionId}`,
        headers: examHeaders(bAttempt.examSessionId),
        payload: { response: { text: 'sabotage' }, revision: 999 },
      });
      expect(r.statusCode).toBe(404);
    });

    it('cannot sync, submit, resume or post events to it', async () => {
      const h = examHeaders(bAttempt.examSessionId);
      const urls = ['sync', 'submit', 'resume', 'events'];
      const payloads: Record<string, object> = {
        sync: { answers: [] },
        submit: {},
        resume: {},
        events: { events: [{ clientEventId: 'x1', type: 'PASTE_ATTEMPT' }] },
      };
      for (const u of urls) {
        const r = await studentA.inject({ method: 'POST', url: `/api/v1/attempts/${bAttempt.attemptId}/${u}`, headers: h, payload: payloads[u] });
        expect(r.statusCode, u).toBe(404);
      }
      const b = await prisma.attempt.findUniqueOrThrow({ where: { id: bAttempt.attemptId } });
      expect(b.status).toBe('IN_PROGRESS');
      expect(b.violationScore).toBe(0);
    });

    it('cannot read B’s result', async () => {
      await studentB.inject({ method: 'POST', url: `/api/v1/attempts/${bAttempt.attemptId}/submit`, headers: examHeaders(bAttempt.examSessionId), payload: {} });
      const r = await studentA.inject({ method: 'GET', url: `/api/v1/results/${bAttempt.attemptId}` });
      expect(r.statusCode).toBe(404);
    });
  });

  describe('expired attempts', () => {
    it('Expired attempt → Save answer is rejected and nothing is stored', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await expireAttempt(a.attemptId);
      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const r = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
        headers: examHeaders(a.examSessionId),
        payload: { response: { text: 'Paris' }, revision: 1 },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('ATTEMPT_EXPIRED');
      expect(await prisma.answer.count({ where: { attemptId: a.attemptId } })).toBe(0);
    });

    it('Expired attempt → Sync is rejected', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await expireAttempt(a.attemptId);
      const q = a.questions[0]!;
      const r = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/sync`,
        headers: examHeaders(a.examSessionId),
        payload: { answers: [{ questionId: q.questionId, response: { text: 'x' }, revision: 1 }] },
      });
      expect(r.statusCode).toBe(409);
    });

    it('Expired attempt → Submit is rejected and the attempt is finalised as EXPIRED', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const correct = await correctResponses(quizId);
      await expireAttempt(a.attemptId);
      const r = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/submit`,
        headers: examHeaders(a.examSessionId),
        // Late "final answers" must not be accepted.
        payload: { answers: a.questions.map((q) => ({ questionId: q.questionId, response: correct.get(q.questionId), revision: 1 })) },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('ATTEMPT_EXPIRED');
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId }, include: { result: true } });
      expect(row.status).toBe('EXPIRED');
      expect(Number(row.result!.score)).toBe(0);
    });

    it('a manipulated client clock cannot extend the exam', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await expireAttempt(a.attemptId);
      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const r = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
        headers: { ...examHeaders(a.examSessionId), date: 'Thu, 01 Jan 2020 00:00:00 GMT' },
        payload: { response: { text: 'Paris' }, revision: 1, clientSavedAt: '2020-01-01T00:00:00Z' },
      });
      expect(r.statusCode).toBe(409);
    });
  });

  describe('duplicates', () => {
    it('Duplicate answer → one row, highest revision wins', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const url = `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`;
      const h = examHeaders(a.examSessionId);
      await Promise.all(
        [3, 1, 3, 2, 3].map((rev) => s.inject({ method: 'PUT', url, headers: h, payload: { response: { text: `rev${rev}` }, revision: rev } })),
      );
      await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      const rows = await prisma.answer.findMany({ where: { attemptId: a.attemptId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.response).toEqual({ text: 'rev3' });
    });

    it('Duplicate submission → one result, second call reports alreadySubmitted', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      const r1 = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      const r2 = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      expect(r1.json().data.alreadySubmitted).toBe(false);
      expect(r2.statusCode).toBe(200);
      expect(r2.json().data.alreadySubmitted).toBe(true);
      expect(await prisma.result.count({ where: { attemptId: a.attemptId } })).toBe(1);
    });

    it('answers after submission are rejected', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const r = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
        headers: h,
        payload: { response: { text: 'Paris' }, revision: 5 },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('ATTEMPT_ALREADY_SUBMITTED');
    });
  });

  describe('tampering', () => {
    it('Modified score → rejected; score is always computed server-side', async () => {
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      const forged = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/submit`,
        headers: h,
        payload: { score: 100, percentage: 100, passed: true },
      });
      expect(forged.statusCode).toBe(400);
      expect(forged.json().error.code).toBe('VALIDATION_ERROR');
      const real = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      expect(real.json().data.result.score).toBe(0);
    });

    it('Modified role → no effect (roles come only from the server-side session)', async () => {
      const { user, client: s } = await userClient('STUDENT');
      const viaHeaders = await s.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { 'x-user-role': 'SUPER_ADMIN', 'x-role': 'SUPER_ADMIN', 'x-permissions': 'MANAGE_USERS' },
      });
      expect(viaHeaders.statusCode).toBe(403);

      const selfPromote = await s.inject({ method: 'PUT', url: `/api/v1/admin/users/${user.id}/roles`, payload: { roles: ['SUPER_ADMIN'] } });
      expect(selfPromote.statusCode).toBe(403);

      const app = await getApp();
      const loginWithRole = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: user.email, password: 'correct-horse-battery', role: 'SUPER_ADMIN' },
      });
      expect(loginWithRole.statusCode).toBe(400);

      const roles = await prisma.userRole.findMany({ where: { userId: user.id }, include: { role: true } });
      expect(roles.map((r) => r.role.name)).toEqual(['STUDENT']);
    });

    it('Modified user_id → ignored; attempts belong to the authenticated user', async () => {
      const { quizId: q2 } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const withUserId = await s.inject({ method: 'POST', url: '/api/v1/attempts', payload: { quizId: q2, userId: studentB.userId } });
      expect(withUserId.statusCode).toBe(400);

      const a = await startAttempt(s, q2);
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
      expect(row.userId).toBe(s.userId);

      const q = a.questions.find((x) => x.type === 'SHORT_TEXT')!;
      const answerWithUser = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
        headers: examHeaders(a.examSessionId),
        payload: { response: { text: 'x' }, revision: 1, userId: studentB.userId },
      });
      expect(answerWithUser.statusCode).toBe(400);
    });

    it('role managers cannot grant permissions they do not hold, nor the SUPER_ADMIN role', async () => {
      // A custom "role manager" with MANAGE_ROLES + MANAGE_USERS only.
      const perms = await prisma.permission.findMany({ where: { key: { in: ['MANAGE_ROLES', 'MANAGE_USERS'] } } });
      const managerRole = await prisma.role.create({
        data: { name: 'ROLE_MANAGER', permissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
      });
      const { user: mgrUser } = await userClient('STUDENT');
      await prisma.userRole.deleteMany({ where: { userId: mgrUser.id } });
      await prisma.userRole.create({ data: { userId: mgrUser.id, roleId: managerRole.id } });
      const { login } = await import('../helpers.js');
      const mgr = await login(mgrUser.email);

      const studentRole = await prisma.role.findUniqueOrThrow({ where: { name: 'STUDENT' } });
      const escalate = await mgr.inject({
        method: 'PUT',
        url: `/api/v1/admin/roles/${studentRole.id}/permissions`,
        payload: { permissions: ['START_EXAM', 'SYSTEM_SETTINGS'] },
      });
      expect(escalate.statusCode).toBe(403);

      const makeSuper = await mgr.inject({ method: 'PUT', url: `/api/v1/admin/users/${studentB.userId}/roles`, payload: { roles: ['SUPER_ADMIN'] } });
      expect(makeSuper.statusCode).toBe(403);

      const examAdminCantManageRoles = await admin.inject({ method: 'GET', url: '/api/v1/admin/roles' });
      expect(examAdminCantManageRoles.statusCode).toBe(403);

      const studentPerms = await prisma.rolePermission.count({ where: { roleId: studentRole.id } });
      expect(studentPerms).toBe(4);
    });

    it('rejects invalid ids, oversized bodies and SQL-ish input safely', async () => {
      const bad = await studentA.inject({ method: 'GET', url: "/api/v1/attempts/1'%20OR%20'1'='1" });
      expect(bad.statusCode).toBe(400);
      const app = await getApp();
      const huge = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) },
      });
      expect(huge.statusCode).toBe(413);
      const sqli = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: "admin@x.com' OR 1=1 --", password: 'x' },
      });
      expect(sqli.statusCode).toBe(400);
    });
  });

  describe('privilege boundaries (review regressions)', () => {
    async function customRoleUser(roleName: string, permissionKeys: string[]) {
      const perms = await prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
      const role = await prisma.role.create({
        data: { name: roleName, permissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
      });
      const { user } = await userClient('STUDENT');
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const { login } = await import('../helpers.js');
      return { user, client: await login(user.email) };
    }

    it('a role manager cannot hand out roles above their own permissions (create or assign)', async () => {
      const { client: mgr } = await customRoleUser('ROLE_MGR_2', ['MANAGE_ROLES', 'MANAGE_USERS']);
      const create = await mgr.inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { email: 'sneaky@test.local', fullName: 'x', password: 'long-enough-password', roles: ['EXAM_ADMIN'] },
      });
      expect(create.statusCode).toBe(403);
      const assign = await mgr.inject({ method: 'PUT', url: `/api/v1/admin/users/${studentA.userId}/roles`, payload: { roles: ['PROCTOR'] } });
      expect(assign.statusCode).toBe(403);
      // Students (self-service permissions only) can still be created.
      const ok = await mgr.inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { email: 'new-student@test.local', fullName: 'New', password: 'long-enough-password' },
      });
      expect(ok.statusCode).toBe(201);
    });

    it('a user manager cannot reset the password of (and take over) a more privileged account', async () => {
      const { client: mgr } = await customRoleUser('USER_MGR', ['MANAGE_USERS']);
      const examAdminUser = await prisma.user.findFirstOrThrow({ where: { id: admin.userId } });
      const reset = await mgr.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${examAdminUser.id}/reset-password`,
        payload: { newPassword: 'attacker-chosen-pass' },
      });
      expect(reset.statusCode).toBe(403);
      const suspend = await mgr.inject({ method: 'PATCH', url: `/api/v1/admin/users/${examAdminUser.id}`, payload: { status: 'SUSPENDED' } });
      expect(suspend.statusCode).toBe(403);
      // Managing students is still allowed.
      const student = await mgr.inject({ method: 'POST', url: `/api/v1/admin/users/${studentB.userId}/revoke-sessions` });
      expect(student.statusCode).toBe(200);
    });

    it('exam admins cannot cancel attempts or read the answer key of quizzes they do not own', async () => {
      const other = (await userClient('EXAM_ADMIN')).client;
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const cancel = await other.inject({ method: 'POST', url: `/api/v1/admin/attempts/${a.attemptId}/cancel`, payload: { reason: 'x' } });
      expect(cancel.statusCode).toBe(403);
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).status).toBe('IN_PROGRESS');
      const detail = await other.inject({ method: 'GET', url: `/api/v1/admin/quizzes/${quizId}` });
      expect(detail.statusCode).toBe(403);
      expect((await admin.inject({ method: 'GET', url: `/api/v1/admin/quizzes/${quizId}` })).statusCode).toBe(200);
    });

    it('ending a quiz does not leak the answer key while classmates are still writing', async () => {
      const { quizId: q } = await createActiveQuiz(admin, { resultsVisibility: 'AFTER_END' });
      const { client: done } = await userClient('STUDENT');
      const { client: writing } = await userClient('STUDENT');
      const d = await startAttempt(done, q);
      await startAttempt(writing, q);
      await done.inject({ method: 'POST', url: `/api/v1/attempts/${d.attemptId}/submit`, headers: examHeaders(d.examSessionId), payload: {} });
      await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${q}/end` });

      const r = await done.inject({ method: 'GET', url: `/api/v1/results/${d.attemptId}` });
      expect(r.statusCode).toBe(200); // score released (AFTER_END)...
      expect(r.body).not.toContain('isCorrect'); // ...but not the key, nor per-question correctness
      expect(r.body).not.toContain('acceptedAnswers');
      expect(r.body).not.toContain('pointsAwarded');
    });

    it('IMMEDIATE results do not reveal per-question correctness while the quiz runs', async () => {
      const { quizId: q } = await createActiveQuiz(admin, { resultsVisibility: 'IMMEDIATE' });
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, q);
      const correct = await correctResponses(q);
      await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/submit`,
        headers: examHeaders(a.examSessionId),
        payload: { answers: a.questions.map((x) => ({ questionId: x.questionId, response: correct.get(x.questionId), revision: 1 })) },
      });
      const r = await s.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
      expect(r.json().data.score).toBe(4);
      for (const qq of r.json().data.questions) {
        expect(qq).not.toHaveProperty('isCorrect');
        expect(qq).not.toHaveProperty('pointsAwarded');
      }
    });
  });

  describe('rate limiting', () => {
    it('limits per user, returns 429 with Retry-After, and isolates users', async () => {
      const { client: s } = await userClient('STUDENT');
      const { client: other } = await userClient('STUDENT');
      // Exhaust the attempt-start bucket (20/min) for one student. 41 requests span at most two
      // fixed windows, so at least one window must exceed 20 regardless of timing.
      const results = [];
      for (let i = 0; i < 41; i++) {
        results.push(await s.inject({ method: 'POST', url: '/api/v1/attempts', payload: { quizId } }));
      }
      const limited = results.filter((r) => r.statusCode === 429);
      expect(limited.length).toBeGreaterThanOrEqual(1);
      expect(limited[0]!.headers['retry-after']).toBeTruthy();
      expect(limited[0]!.json().error.code).toBe('RATE_LIMITED');
      // A classmate behind the same IP is unaffected.
      const ok = await other.inject({ method: 'POST', url: '/api/v1/attempts', payload: { quizId } });
      expect([200, 201]).toContain(ok.statusCode);
    });

    it('normal autosave cadence stays far below the answer limit', async () => {
      // One save every 5 s for a minute = 12 requests vs a limit of 180/min.
      for (let i = 0; i < 12; i++) {
        const r = await consume('answer', 'u:cadence-check', 180, 60);
        expect(r.allowed).toBe(true);
      }
    });
  });
});
