import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  resetDb,
  startAttempt,
  userClient,
  type Client,
} from '../helpers.js';

describe('exam flow', () => {
  let admin: Client;

  beforeAll(async () => {
    await resetDb();
    await getApp();
    admin = (await userClient('EXAM_ADMIN')).client;
  });
  afterAll(closeApp);

  it('start: server computes the timer and persists the randomised mapping', async () => {
    const { quizId } = await createActiveQuiz(admin, { durationSeconds: 900 });
    const { client: s } = await userClient('STUDENT');
    const before = Date.now();
    const a = await startAttempt(s, quizId);
    const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId }, include: { questions: true } });
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.expiresAt.getTime() - row.startedAt.getTime()).toBe(900_000);
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.questions).toHaveLength(3);
    // No correct answers leak to the student.
    expect(JSON.stringify(a.raw)).not.toMatch(/isCorrect|acceptedAnswers|Paris/);

    // Reloading shows the identical order (persisted, not re-randomised).
    const again = await s.inject({ method: 'GET', url: `/api/v1/attempts/${a.attemptId}` });
    expect(again.json().data.questions.map((q: { questionId: string }) => q.questionId)).toEqual(a.questions.map((q) => q.questionId));
    expect(again.json().data.questions[0].options).toEqual(a.questions[0]!.options);
  });

  it('start is idempotent and concurrent starts produce exactly one attempt', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => s.inject({ method: 'POST', url: '/api/v1/attempts', payload: { quizId } })),
    );
    if (!results.every((r) => r.statusCode === 200 || r.statusCode === 201)) console.log('STARTCODES', results.map((r) => r.statusCode + ' ' + r.body.slice(0, 160)).join(' | '));
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().data.attempt.id)).size).toBe(1);
    expect(await prisma.attempt.count({ where: { quizId, userId: s.userId } })).toBe(1);
    expect(await prisma.examSession.count({ where: { attempt: { quizId }, status: 'ACTIVE' } })).toBe(1);
  });

  it('enforces maxAttempts', async () => {
    const { quizId } = await createActiveQuiz(admin, { maxAttempts: 1 });
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: examHeaders(a.examSessionId), payload: {} });
    const r = await s.inject({ method: 'POST', url: '/api/v1/attempts', payload: { quizId } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('MAX_ATTEMPTS_REACHED');
  });

  it('answers: buffered in Redis, flushed to Postgres, revision-guarded and idempotent', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const single = a.questions.find((q) => q.type === 'SINGLE_CHOICE')!;
    const url = `/api/v1/attempts/${a.attemptId}/answers/${single.questionId}`;
    const h = examHeaders(a.examSessionId);

    const r1 = await s.inject({ method: 'PUT', url, headers: h, payload: { response: { selectedOptionIds: [single.options[0]!.id] }, revision: 2 } });
    expect(r1.json().data.status).toBe('accepted');
    // Retry of the same request → duplicate, not a second row.
    const r2 = await s.inject({ method: 'PUT', url, headers: h, payload: { response: { selectedOptionIds: [single.options[0]!.id] }, revision: 2 } });
    expect(r2.json().data.status).toBe('duplicate');
    // Out-of-order older request → ignored.
    const r3 = await s.inject({ method: 'PUT', url, headers: h, payload: { response: { selectedOptionIds: [single.options[1]!.id] }, revision: 1 } });
    expect(r3.json().data.status).toBe('stale');
    expect(r3.json().data.serverRevision).toBe(2);

    // Nothing in Postgres until the write-behind flush runs.
    expect(await prisma.answer.count({ where: { attemptId: a.attemptId } })).toBe(0);
    await flushDirtyAttempts();
    await flushDirtyAttempts();
    const rows = await prisma.answer.findMany({ where: { attemptId: a.attemptId } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.revision)).toBe(2);
    expect(rows[0]!.response).toEqual({ selectedOptionIds: [single.options[0]!.id] });
  });

  it('answers are validated against the attempt’s own questions/options', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { quizId: otherQuiz } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const h = examHeaders(a.examSessionId);
    const foreignQ = await prisma.question.findFirstOrThrow({ where: { quizId: otherQuiz } });
    const r = await s.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${foreignQ.id}`,
      headers: h,
      payload: { response: { text: 'x' }, revision: 1 },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('QUESTION_NOT_IN_ATTEMPT');

    const single = a.questions.find((q) => q.type === 'SINGLE_CHOICE')!;
    const multi = a.questions.find((q) => q.type === 'MULTIPLE_CHOICE')!;
    const wrongOption = await s.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${single.questionId}`,
      headers: h,
      payload: { response: { selectedOptionIds: [multi.options[0]!.id] }, revision: 1 },
    });
    expect(wrongOption.statusCode).toBe(422);
    const twoForSingle = await s.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${single.questionId}`,
      headers: h,
      payload: { response: { selectedOptionIds: [single.options[0]!.id, single.options[1]!.id] }, revision: 1 },
    });
    expect(twoForSingle.statusCode).toBe(422);
  });

  it('offline recovery: a batched sync after reconnect is persisted and reconciled', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const correct = await correctResponses(quizId);
    const h = examHeaders(a.examSessionId);

    // Client was offline: OFFLINE/ONLINE events are informational and never penalised.
    await s.inject({
      method: 'POST',
      url: `/api/v1/attempts/${a.attemptId}/events`,
      headers: h,
      payload: { events: [{ clientEventId: 'off-1', type: 'OFFLINE' }, { clientEventId: 'on-1', type: 'ONLINE' }] },
    });

    const answers = a.questions.map((q, i) => ({
      questionId: q.questionId,
      response: correct.get(q.questionId),
      revision: 10 + i,
      clientSavedAt: new Date().toISOString(),
    }));
    const sync = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/sync`, headers: h, payload: { answers } });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().data.results.every((r: { status: string }) => r.status === 'accepted')).toBe(true);
    expect(sync.json().data.serverAnswers).toHaveLength(3);

    // Re-sending the same batch (flaky network) is harmless.
    const again = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/sync`, headers: h, payload: { answers } });
    expect(again.json().data.results.every((r: { status: string }) => r.status === 'duplicate')).toBe(true);

    const sub = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} });
    expect(sub.json().data.result).toMatchObject({ score: 4, maxScore: 4, percentage: 100 });
    const attempt = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    expect(attempt.violationScore).toBe(0);
  });

  it('submit: final answers in the body are saved, graded server-side, and result is unique', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const correct = await correctResponses(quizId);
    const single = a.questions.find((q) => q.type === 'SINGLE_CHOICE')!;
    const wrong = single.options.find((o) => !(correct.get(single.questionId) as { selectedOptionIds: string[] }).selectedOptionIds.includes(o.id))!;
    const multi = a.questions.find((q) => q.type === 'MULTIPLE_CHOICE')!;

    const r = await s.inject({
      method: 'POST',
      url: `/api/v1/attempts/${a.attemptId}/submit`,
      headers: examHeaders(a.examSessionId),
      payload: {
        answers: [
          { questionId: single.questionId, response: { selectedOptionIds: [wrong.id] }, revision: 1 },
          { questionId: multi.questionId, response: correct.get(multi.questionId), revision: 1 },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    // 2 (multi) − 0.25 (negative mark) = 1.75 of 4; short text unanswered.
    expect(r.json().data.result).toMatchObject({ score: 1.75, maxScore: 4, percentage: 43.75 });
    const result = await prisma.result.findUniqueOrThrow({ where: { attemptId: a.attemptId } });
    expect(result).toMatchObject({ correctCount: 1, incorrectCount: 1, unansweredCount: 1 });
    const graded = await prisma.answer.findMany({ where: { attemptId: a.attemptId } });
    expect(graded.every((g) => g.isCorrect !== null)).toBe(true);
  });

  it('concurrent duplicate submissions create exactly one result', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const h = examHeaders(a.examSessionId);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: h, payload: {} })),
    );
    const ok = responses.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Anything not 200 must be a clean, retryable error — never a 500.
    for (const r of responses) expect([200, 409, 429, 503]).toContain(r.statusCode);
    expect(ok.filter((r) => r.json().data.alreadySubmitted === false)).toHaveLength(1);
    expect(await prisma.result.count({ where: { attemptId: a.attemptId } })).toBe(1);
  });

  it('expiry worker auto-submits abandoned attempts using saved answers', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const correct = await correctResponses(quizId);
    const text = a.questions.find((q) => q.type === 'SHORT_TEXT')!;
    await s.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${text.questionId}`,
      headers: examHeaders(a.examSessionId),
      payload: { response: correct.get(text.questionId), revision: 1 },
    });
    // Answer is still only in the Redis buffer when time runs out.
    await expireAttempt(a.attemptId);
    expect(await sweepExpiredAttempts()).toBeGreaterThanOrEqual(1);

    const attempt = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId }, include: { result: true } });
    expect(attempt.status).toBe('EXPIRED');
    expect(Number(attempt.result!.score)).toBe(1); // buffered answer was not lost
  });

  it('device takeover: old exam session is superseded and a SESSION_CHANGE signal is recorded', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { user, client: laptop } = await userClient('STUDENT');
    const a = await startAttempt(laptop, quizId);

    // Same login reloading the page re-uses the exam session.
    const reload = await laptop.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/resume`, payload: {} });
    expect(reload.json().data.examSessionId).toBe(a.examSessionId);
    expect(reload.json().data.tookOver).toBe(false);

    // Laptop dies; student logs in on another device.
    const phone = await login(user.email);
    const resumed = await phone.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/resume`, payload: { deviceInfo: { kind: 'phone' } } });
    expect(resumed.statusCode).toBe(200);
    const newSession = resumed.json().data.examSessionId;
    expect(newSession).not.toBe(a.examSessionId);
    expect(resumed.json().data.tookOver).toBe(true);

    const q = a.questions[0]!;
    const stale = await laptop.inject({
      method: 'PUT',
      url: `/api/v1/attempts/${a.attemptId}/answers/${q.questionId}`,
      headers: examHeaders(a.examSessionId),
      payload: { response: q.type === 'SHORT_TEXT' ? { text: 'x' } : { selectedOptionIds: [] }, revision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('EXAM_SESSION_SUPERSEDED');

    const events = await prisma.examEvent.findMany({ where: { attemptId: a.attemptId, type: 'SESSION_CHANGE' } });
    expect(events).toHaveLength(1);
    expect(events[0]!.weight).toBeGreaterThan(0);
  });

  it('writes without the exam session header are rejected', async () => {
    const { quizId } = await createActiveQuiz(admin);
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const r = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('EXAM_SESSION_REQUIRED');
  });

  it('anti-cheating: events accumulate into a flag for human review (not auto-penalised)', async () => {
    const { quizId } = await createActiveQuiz(admin, { violationThreshold: 3 });
    const { client: s } = await userClient('STUDENT');
    const proctor = (await userClient('PROCTOR')).client;
    const a = await startAttempt(s, quizId);
    const h = examHeaders(a.examSessionId);
    const send = (events: object[]) =>
      s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/events`, headers: h, payload: { events } });

    const one = await send([{ clientEventId: 'e1', type: 'TAB_HIDDEN', timestamp: new Date().toISOString() }]);
    expect(one.statusCode).toBe(202);
    let row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    expect(row.violationScore).toBe(1);
    expect(row.flaggedAt).toBeNull(); // a single event is not proof of anything

    // Retried batch is deduplicated by clientEventId.
    const dup = await send([{ clientEventId: 'e1', type: 'TAB_HIDDEN' }]);
    expect(dup.json().data).toMatchObject({ stored: 0, duplicates: 1 });

    await send([
      { clientEventId: 'e2', type: 'TAB_VISIBLE' },
      { clientEventId: 'e3', type: 'PASTE_ATTEMPT', metadata: { length: 120 } },
    ]);
    row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
    expect(row.violationScore).toBe(3);
    expect(row.flaggedAt).not.toBeNull();
    expect(row.reviewStatus).toBe('PENDING');
    expect(row.status).toBe('IN_PROGRESS'); // exam continues

    const list = await proctor.inject({ method: 'GET', url: `/api/v1/admin/violations?quizId=${quizId}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.items[0].signals).toMatchObject({ TAB_HIDDEN: 1, PASTE_ATTEMPT: 1 });

    const review = await proctor.inject({
      method: 'POST',
      url: `/api/v1/admin/violations/${a.attemptId}/review`,
      payload: { decision: 'CLEARED', notes: 'Student reported a notification popup.' },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().data.reviewStatus).toBe('CLEARED');
  });

  it('results visibility: AFTER_END hides results until the quiz ends; answers revealed only after end', async () => {
    const { quizId } = await createActiveQuiz(admin, { resultsVisibility: 'AFTER_END' });
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    const sub = await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: examHeaders(a.examSessionId), payload: {} });
    expect(sub.json().data.result).toBeNull();

    const early = await s.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('RESULT_NOT_RELEASED');

    const staff = await admin.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
    expect(staff.statusCode).toBe(200);

    await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/end` });
    const after = await s.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain('isCorrect');
  });

  it('IMMEDIATE results never reveal correct options while the quiz is still running', async () => {
    const { quizId } = await createActiveQuiz(admin, { resultsVisibility: 'IMMEDIATE' });
    const { client: s } = await userClient('STUDENT');
    const a = await startAttempt(s, quizId);
    await s.inject({ method: 'POST', url: `/api/v1/attempts/${a.attemptId}/submit`, headers: examHeaders(a.examSessionId), payload: {} });
    const r = await s.inject({ method: 'GET', url: `/api/v1/results/${a.attemptId}` });
    expect(r.statusCode).toBe(200);
    const options = r.json().data.questions.flatMap((q: { options: object[] }) => q.options);
    expect(options.every((o: object) => !('isCorrect' in o))).toBe(true);
    expect(r.body).not.toContain('acceptedAnswers');
  });

  it('admin can list attempts and results with stats', async () => {
    const attempts = await admin.inject({ method: 'GET', url: '/api/v1/admin/attempts?pageSize=5' });
    expect(attempts.statusCode).toBe(200);
    expect(attempts.json().data.pagination.pageSize).toBe(5);
    const results = await admin.inject({ method: 'GET', url: '/api/v1/admin/results' });
    expect(results.statusCode).toBe(200);
    expect(results.json().data.stats.averagePercentage).not.toBeNull();
  });
});
