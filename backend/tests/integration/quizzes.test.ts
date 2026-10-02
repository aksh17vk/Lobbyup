import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, createActiveQuiz, getApp, prisma, resetDb, startAttempt, userClient, type Client } from '../helpers.js';

describe('quiz administration & lifecycle', () => {
  let admin: Client;
  let otherAdmin: Client;
  let superAdmin: Client;
  let student: Client;

  beforeAll(async () => {
    await resetDb();
    await getApp();
    admin = (await userClient('EXAM_ADMIN')).client;
    otherAdmin = (await userClient('EXAM_ADMIN')).client;
    superAdmin = (await userClient('SUPER_ADMIN')).client;
    student = (await userClient('STUDENT')).client;
  });
  afterAll(closeApp);

  async function draftQuiz(owner = admin) {
    const r = await owner.inject({ method: 'POST', url: '/api/v1/admin/quizzes', payload: { title: 'Draft', durationSeconds: 300 } });
    expect(r.statusCode).toBe(201);
    return r.json().data.id as string;
  }

  it('creates a quiz in DRAFT owned by the creator', async () => {
    const id = await draftQuiz();
    const q = await prisma.quiz.findUniqueOrThrow({ where: { id } });
    expect(q.status).toBe('DRAFT');
    expect(q.createdById).toBe(admin.userId);
  });

  it('refuses to publish an empty or invalid quiz', async () => {
    const id = await draftQuiz();
    const r = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${id}/publish` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toContain('Quiz has no questions.');
  });

  it('walks DRAFT → PUBLISHED → ACTIVE → ENDED → ARCHIVED and rejects illegal jumps', async () => {
    const id = await draftQuiz();
    await admin.inject({
      method: 'POST',
      url: `/api/v1/admin/quizzes/${id}/questions`,
      payload: { type: 'SHORT_TEXT', prompt: 'Q', acceptedAnswers: ['a'] },
    });
    const illegal = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${id}/activate` });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().error.code).toBe('INVALID_STATE_TRANSITION');

    for (const [action, status] of [
      ['publish', 'PUBLISHED'],
      ['activate', 'ACTIVE'],
      ['end', 'ENDED'],
      ['archive', 'ARCHIVED'],
    ]) {
      const r = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${id}/${action}` });
      expect(r.statusCode, action).toBe(200);
      expect(r.json().data.status).toBe(status);
    }
    const audit = await prisma.auditLog.count({ where: { entityId: id, action: { startsWith: 'quiz.' } } });
    expect(audit).toBeGreaterThanOrEqual(5);
  });

  it('freezes content once published', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const add = await admin.inject({
      method: 'POST',
      url: `/api/v1/admin/quizzes/${quizId}/questions`,
      payload: { type: 'SHORT_TEXT', prompt: 'Late', acceptedAnswers: ['x'] },
    });
    expect(add.statusCode).toBe(409);
    expect(add.json().error.code).toBe('QUIZ_NOT_EDITABLE');
    const q = await prisma.question.findFirstOrThrow({ where: { quizId } });
    const del = await admin.inject({ method: 'DELETE', url: `/api/v1/admin/questions/${q.id}` });
    expect(del.statusCode).toBe(409);
  });

  it('only the owner (or a super admin) can modify a quiz', async () => {
    const id = await draftQuiz();
    const foreign = await otherAdmin.inject({ method: 'PUT', url: `/api/v1/admin/quizzes/${id}`, payload: { title: 'Hijack' } });
    expect(foreign.statusCode).toBe(403);
    const sup = await superAdmin.inject({ method: 'PUT', url: `/api/v1/admin/quizzes/${id}`, payload: { title: 'Fixed' } });
    expect(sup.statusCode).toBe(200);
    expect(sup.json().data.title).toBe('Fixed');
  });

  it('cannot unpublish or delete once attempts exist', async () => {
    const { quizId } = await createActiveQuiz(admin);
    await startAttempt(student, quizId);
    await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/end` });
    const del = await admin.inject({ method: 'DELETE', url: `/api/v1/admin/quizzes/${quizId}` });
    expect(del.statusCode).toBe(409);
  });

  it('question pools: each attempt draws drawCount questions', async () => {
    const id = await draftQuiz();
    const pool = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${id}/pools`, payload: { name: 'Hard', drawCount: 2 } });
    expect(pool.statusCode).toBe(201);
    const poolId = pool.json().data.id;
    await admin.inject({
      method: 'POST',
      url: `/api/v1/admin/quizzes/${id}/questions`,
      payload: {
        questions: [
          { type: 'SHORT_TEXT', prompt: 'always', acceptedAnswers: ['a'] },
          ...Array.from({ length: 5 }, (_, i) => ({ type: 'SHORT_TEXT', prompt: `pool ${i}`, acceptedAnswers: ['a'], poolId })),
        ],
      },
    });
    await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${id}/publish` });
    await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${id}/activate` });

    const a = await startAttempt(student, id);
    expect(a.questions).toHaveLength(3);
    expect(a.questions.some((q) => q.prompt === 'always')).toBe(true);
  });

  it('students only see published/active quizzes, never drafts or answers', async () => {
    const draftId = await draftQuiz();
    const { quizId } = await createActiveQuiz(admin);
    const list = await student.inject({ method: 'GET', url: '/api/v1/quizzes' });
    expect(list.statusCode).toBe(200);
    const ids = list.json().data.map((q: { id: string }) => q.id);
    expect(ids).toContain(quizId);
    expect(ids).not.toContain(draftId);
    expect(list.body).not.toContain('isCorrect');
    expect((await student.inject({ method: 'GET', url: `/api/v1/quizzes/${draftId}` })).statusCode).toBe(404);
  });

  it('student cannot use admin quiz APIs', async () => {
    const r = await student.inject({ method: 'POST', url: '/api/v1/admin/quizzes', payload: { title: 'x', durationSeconds: 300 } });
    expect(r.statusCode).toBe(403);
    expect((await student.inject({ method: 'GET', url: '/api/v1/admin/quizzes' })).statusCode).toBe(403);
  });
});
