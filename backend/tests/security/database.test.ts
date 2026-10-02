/**
 * Database / RBAC / security PRD: least privilege, constraints, relations, invalid ids,
 * student ids, marks, data minimisation and retention.
 * NOTE: `prisma` here is the least-privileged APP role (see vitest.config.ts); `ownerDb` is the
 * schema owner.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetention } from '../../src/workers/retention.worker.js';
import {
  closeApp,
  correctResponses,
  createActiveQuiz,
  createUser,
  examHeaders,
  getApp,
  login,
  ownerDb,
  prisma,
  resetDb,
  startAttempt,
  userClient,
  type Client,
} from '../helpers.js';

const denied = async (p: Promise<unknown>) => {
  const err = (await p.then(() => null, (e) => e)) as { meta?: { code?: string }; message?: string } | null;
  expect(err, 'expected the statement to be rejected').not.toBeNull();
  // 42501 = insufficient_privilege
  expect(`${err?.meta?.code ?? ''} ${err?.message ?? ''}`).toMatch(/42501|permission denied|must be owner/i);
};

describe('database security', () => {
  let admin: Client;
  let superAdmin: Client;

  beforeAll(async () => {
    await resetDb();
    await getApp();
    admin = (await userClient('EXAM_ADMIN')).client;
    superAdmin = (await userClient('SUPER_ADMIN')).client;
  });
  afterAll(closeApp);

  describe('least-privilege application role', () => {
    it('the API runs as a role that is not the schema owner', async () => {
      const [me] = await prisma.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      const [owner] = await ownerDb.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      expect(me!.current_user).toBe('lobbyup_app_test');
      expect(me!.current_user).not.toBe(owner!.current_user);
    });

    it('cannot run DDL or TRUNCATE', async () => {
      await denied(prisma.$executeRaw`CREATE TABLE evil (id int)`);
      await denied(prisma.$executeRaw`DROP TABLE results`);
      await denied(prisma.$executeRaw`ALTER TABLE users ADD COLUMN is_admin boolean`);
      await denied(prisma.$executeRaw`TRUNCATE exam_events`);
      await denied(prisma.$executeRaw`CREATE INDEX evil_idx ON users (full_name)`);
    });

    it('provisioning verifies the effective privileges of the app role', async () => {
      const { verifyAppRole } = await import('../../src/db/app-role.js');
      expect(await verifyAppRole(ownerDb, 'lobbyup_app_test')).toEqual([]);
    });

    it('the audit log stays append-only even if grants are misconfigured (trigger)', async () => {
      await prisma.auditLog.create({ data: { action: 'test.trigger', entityType: 'test' } });
      await ownerDb.$executeRaw`GRANT UPDATE, DELETE ON audit_logs TO lobbyup_app_test`;
      try {
        await denied(prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered'`);
        await denied(prisma.$executeRaw`DELETE FROM audit_logs`);
      } finally {
        await ownerDb.$executeRaw`REVOKE UPDATE, DELETE ON audit_logs FROM lobbyup_app_test`;
      }
    });

    it('can only append to the audit log, and cannot see migration history', async () => {
      await prisma.auditLog.create({ data: { action: 'test.append', entityType: 'test' } });
      await denied(prisma.$executeRaw`UPDATE audit_logs SET action = 'tampered'`);
      await denied(prisma.$executeRaw`DELETE FROM audit_logs`);
      await denied(prisma.$queryRaw`SELECT * FROM _prisma_migrations`);
      expect(await ownerDb.auditLog.count({ where: { action: 'tampered' } })).toBe(0);
    });
  });

  describe('constraints and relations', () => {
    it('enforces unique email and unique student_id (multiple NULLs allowed)', async () => {
      const a = await createUser('STUDENT');
      await expect(prisma.user.create({ data: { email: a.email, fullName: 'x', passwordHash: 'x' } })).rejects.toMatchObject({ code: 'P2002' });
      await prisma.user.update({ where: { id: a.id }, data: { studentId: 'S-0001' } });
      const b = await createUser('STUDENT');
      await expect(prisma.user.update({ where: { id: b.id }, data: { studentId: 'S-0001' } })).rejects.toMatchObject({ code: 'P2002' });
      // Staff without a student id: NULL never collides.
      await createUser('PROCTOR');
      await createUser('PROCTOR');
    });

    it('rejects impossible data at the database level', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      await expect(
        prisma.attempt.update({ where: { id: a.attemptId }, data: { expiresAt: new Date(0) } }),
      ).rejects.toThrow(); // CHECK expires_at > started_at
      await expect(prisma.quiz.update({ where: { id: quizId }, data: { passingMarks: -1 } })).rejects.toThrow();
      await expect(
        prisma.answer.create({
          data: { attemptId: a.attemptId, questionId: randomUUID(), response: { text: 'x' }, revision: 1 },
        }),
      ).rejects.toThrow(); // composite FK: question must belong to the attempt
    });

    it('cascades quiz → questions → options, and protects users that have attempts', async () => {
      const created = await admin.inject({ method: 'POST', url: '/api/v1/admin/quizzes', payload: { title: 'Cascade', durationSeconds: 300 } });
      const quizId = created.json().data.id;
      await admin.inject({
        method: 'POST',
        url: `/api/v1/admin/quizzes/${quizId}/questions`,
        payload: { type: 'SINGLE_CHOICE', prompt: 'Q', options: [{ text: 'a', isCorrect: true }, { text: 'b', isCorrect: false }] },
      });
      const q = await prisma.question.findFirstOrThrow({ where: { quizId } });
      expect((await admin.inject({ method: 'DELETE', url: `/api/v1/admin/quizzes/${quizId}` })).statusCode).toBe(200);
      expect(await prisma.question.count({ where: { quizId } })).toBe(0);
      expect(await prisma.questionOption.count({ where: { questionId: q.id } })).toBe(0);

      const { quizId: live } = await createActiveQuiz(admin);
      const { user, client: s } = await userClient('STUDENT');
      await startAttempt(s, live);
      await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow(); // attempts are kept (RESTRICT)
    });
  });

  describe('invalid identifiers', () => {
    it('rejects an invalid question id and an invalid option id, and stores nothing', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      const single = a.questions.find((x) => x.type === 'SINGLE_CHOICE')!;

      const badQuestion = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${randomUUID()}`,
        headers: h,
        payload: { response: { text: 'x' }, revision: 1 },
      });
      expect(badQuestion.statusCode).toBe(422);
      expect(badQuestion.json().error.code).toBe('QUESTION_NOT_IN_ATTEMPT');

      const badOption = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/${single.questionId}`,
        headers: h,
        payload: { response: { selectedOptionIds: [randomUUID()] }, revision: 1 },
      });
      expect(badOption.statusCode).toBe(422);
      expect(badOption.json().error.code).toBe('INVALID_ANSWER');

      const malformed = await s.inject({
        method: 'PUT',
        url: `/api/v1/attempts/${a.attemptId}/answers/not-a-uuid`,
        headers: h,
        payload: { response: { text: 'x' }, revision: 1 },
      });
      expect(malformed.statusCode).toBe(400);

      const viaSync = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/sync`,
        headers: h,
        payload: { answers: [{ questionId: single.questionId, response: { selectedOptionIds: [randomUUID()] }, revision: 2 }] },
      });
      expect(viaSync.statusCode).toBe(422);
      expect(await prisma.answer.count({ where: { attemptId: a.attemptId } })).toBe(0);
    });
  });

  describe('student ids', () => {
    it('admins can create, search and update student ids; duplicates and bad formats are rejected', async () => {
      const create = await superAdmin.inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { users: [{ email: 'roll1@test.local', fullName: 'Roll One', studentId: '21CS001', password: 'long-enough-password' }] },
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().data[0].studentId).toBe('21CS001');

      const dup = await superAdmin.inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { email: 'roll2@test.local', fullName: 'Roll Two', studentId: '21CS001', password: 'long-enough-password' },
      });
      expect(dup.statusCode).toBe(409);

      const bad = await superAdmin.inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { email: 'roll3@test.local', fullName: 'Roll Three', studentId: '<script>', password: 'long-enough-password' },
      });
      expect(bad.statusCode).toBe(400);

      const found = await superAdmin.inject({ method: 'GET', url: '/api/v1/admin/users?q=21cs001' });
      expect(found.json().data.items.map((u: { email: string }) => u.email)).toContain('roll1@test.local');

      const me = await (await login('roll1@test.local', 'long-enough-password')).inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(me.json().data.studentId).toBe('21CS001');
    });
  });

  describe('marks', () => {
    it('total marks are computed by the server at publish; passing marks decide pass/fail; attempts store the score', async () => {
      const created = await admin.inject({
        method: 'POST',
        url: '/api/v1/admin/quizzes',
        payload: { title: 'Marks', durationSeconds: 600, passingMarks: 3, resultsVisibility: 'IMMEDIATE' },
      });
      const quizId = created.json().data.id;
      const forged = await admin.inject({ method: 'PUT', url: `/api/v1/admin/quizzes/${quizId}`, payload: { totalMarks: 999 } });
      expect(forged.statusCode).toBe(400); // not client-settable

      await admin.inject({
        method: 'POST',
        url: `/api/v1/admin/quizzes/${quizId}/questions`,
        payload: {
          questions: [
            { type: 'SHORT_TEXT', prompt: 'A', points: 2, acceptedAnswers: ['a'] },
            { type: 'SHORT_TEXT', prompt: 'B', points: 2, acceptedAnswers: ['b'] },
          ],
        },
      });
      const pub = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/publish` });
      expect(pub.statusCode).toBe(200);
      expect(Number(pub.json().data.totalMarks)).toBe(4);
      await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/activate` });

      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      expect(a.raw.quiz.totalMarks).toBe(4);
      const first = a.questions[0]!;
      const correct = await correctResponses(quizId);
      const r = await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/submit`,
        headers: examHeaders(a.examSessionId),
        payload: { answers: [{ questionId: first.questionId, response: correct.get(first.questionId), revision: 1 }] },
      });
      expect(r.json().data.result).toMatchObject({ score: 2, maxScore: 4, passed: false }); // 2 < passing 3
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
      expect(Number(row.score)).toBe(2);
    });

    it('quizzes without a stored total (published before the column existed) are still checked', async () => {
      const { quizId } = await createActiveQuiz(admin); // 3 questions, total 4
      await ownerDb.quiz.update({ where: { id: quizId }, data: { status: 'PUBLISHED', totalMarks: null } });
      const tooHigh = await admin.inject({ method: 'PUT', url: `/api/v1/admin/quizzes/${quizId}`, payload: { passingMarks: 500 } });
      expect(tooHigh.statusCode).toBe(400);
      expect((await admin.inject({ method: 'PUT', url: `/api/v1/admin/quizzes/${quizId}`, payload: { passingMarks: 3 } })).statusCode).toBe(200);
      const act = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/activate` });
      expect(act.statusCode).toBe(200);
      expect(Number(act.json().data.totalMarks)).toBe(4); // filled in on activation
    });

    it('refuses to publish when the pass mark exceeds the total, or a pool mixes marks', async () => {
      const q1 = (await admin.inject({ method: 'POST', url: '/api/v1/admin/quizzes', payload: { title: 'Too high', durationSeconds: 300, passingMarks: 50 } })).json().data.id;
      await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${q1}/questions`, payload: { type: 'SHORT_TEXT', prompt: 'Q', acceptedAnswers: ['x'] } });
      const p1 = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${q1}/publish` });
      expect(p1.statusCode).toBe(400);
      expect(JSON.stringify(p1.json().error.details)).toMatch(/exceed total marks/);

      const q2 = (await admin.inject({ method: 'POST', url: '/api/v1/admin/quizzes', payload: { title: 'Mixed pool', durationSeconds: 300 } })).json().data.id;
      const pool = (await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${q2}/pools`, payload: { name: 'P', drawCount: 1 } })).json().data.id;
      await admin.inject({
        method: 'POST',
        url: `/api/v1/admin/quizzes/${q2}/questions`,
        payload: {
          questions: [
            { type: 'SHORT_TEXT', prompt: 'easy', points: 1, acceptedAnswers: ['x'], poolId: pool },
            { type: 'SHORT_TEXT', prompt: 'hard', points: 5, acceptedAnswers: ['y'], poolId: pool },
          ],
        },
      });
      const p2 = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${q2}/publish` });
      expect(p2.statusCode).toBe(400);
      expect(JSON.stringify(p2.json().error.details)).toMatch(/different marks/);
    });
  });

  describe('privacy', () => {
    it('event metadata is limited to small scalar values', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const send = (metadata: unknown) =>
        s.inject({
          method: 'POST',
          url: `/api/v1/attempts/${a.attemptId}/events`,
          headers: examHeaders(a.examSessionId),
          payload: { events: [{ clientEventId: randomUUID(), type: 'PASTE_ATTEMPT', metadata }] },
        });
      expect((await send({ length: 120, source: 'keyboard' })).statusCode).toBe(202);
      expect((await send({ clipboard: { text: 'secret answer' } })).statusCode).toBe(400);
      expect((await send({ text: 'x'.repeat(500) })).statusCode).toBe(400);
      expect((await send({ 'bad key!': 1 })).statusCode).toBe(400);
    });

    it('proctoring data (IPs, devices, event counts) needs VIEW_VIOLATIONS, not just VIEW_ATTEMPTS', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key: 'VIEW_ATTEMPTS' } });
      const role = await prisma.role.create({ data: { name: 'ATTEMPT_VIEWER', permissions: { create: [{ permissionId: perm.id }] } } });
      const viewer = await createUser('STUDENT');
      await prisma.userRole.deleteMany({ where: { userId: viewer.id } });
      await prisma.userRole.create({ data: { userId: viewer.id, roleId: role.id } });
      const v = await login(viewer.email);

      const limited = (await v.inject({ method: 'GET', url: `/api/v1/admin/attempts/${a.attemptId}` })).json().data;
      expect(limited.ipAddress).toBeUndefined();
      expect(limited.eventCounts).toBeUndefined();
      expect(limited.examSessions[0].ipAddress).toBeUndefined();
      expect(limited.examSessions[0].userAgent).toBeUndefined();

      const full = (await admin.inject({ method: 'GET', url: `/api/v1/admin/attempts/${a.attemptId}` })).json().data;
      expect(full).toHaveProperty('eventCounts');
      expect(full.examSessions[0]).toHaveProperty('userAgent');
    });

    it('retention removes proctoring data of old finished attempts but keeps academic records', async () => {
      const { quizId } = await createActiveQuiz(admin);
      const { client: s } = await userClient('STUDENT');
      const a = await startAttempt(s, quizId);
      const h = examHeaders(a.examSessionId);
      await s.inject({
        method: 'POST',
        url: `/api/v1/attempts/${a.attemptId}/events`,
        headers: h,
        payload: { events: [{ clientEventId: 'r1', type: 'TAB_HIDDEN' }] },
      });
      await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
      // A session left ACTIVE by an interrupted close is stale once the attempt is finished.
      await prisma.examSession.updateMany({ where: { attemptId: a.attemptId }, data: { status: 'ACTIVE', endedAt: null } });
      const loggedOut = await login((await createUser('STUDENT')).email);
      await loggedOut.inject({ method: 'POST', url: '/api/v1/auth/logout' });

      // A live attempt elsewhere must be untouched.
      const { client: other } = await userClient('STUDENT');
      const live = await startAttempt(other, quizId);

      const out = await runRetention(new Date(Date.now() + 400 * 24 * 3600_000));
      expect(out.events).toBeGreaterThanOrEqual(1);
      expect(await prisma.examEvent.count({ where: { attemptId: a.attemptId } })).toBe(0);
      expect(await prisma.examSession.count({ where: { attemptId: a.attemptId } })).toBe(0);
      const kept = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId }, include: { result: true } });
      expect(kept.ipAddress).toBeNull();
      expect(kept.status).toBe('SUBMITTED');
      expect(kept.result).not.toBeNull(); // results are academic records: kept
      expect(kept.violationScore).toBe(1); // aggregate kept for integrity review
      expect(await prisma.session.count({ where: { userId: loggedOut.userId } })).toBe(0);
      expect(await prisma.examSession.count({ where: { attemptId: live.attemptId, status: 'ACTIVE' } })).toBe(1);
    });
  });
});
