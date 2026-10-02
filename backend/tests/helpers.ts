import { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/db/redis.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { refreshAttemptMeta } from '../src/modules/attempts/attempt.cache.js';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, type RoleName } from '../src/modules/permissions/catalog.js';

export { prisma, redis };

let app: FastifyInstance | null = null;

/** Schema-owner connection, used only for resets (the app role cannot TRUNCATE). */
export const ownerDb = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });

export async function getApp() {
  if (!app) {
    if (redis.status === 'wait') await redis.connect();
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp() {
  await app?.close();
  app = null;
  await redis.quit().catch(() => {});
  await prisma.$disconnect();
  await ownerDb.$disconnect();
}

/** Wipe all data and re-create the RBAC catalogue. */
export async function resetDb() {
  await ownerDb.$executeRawUnsafe(`
    TRUNCATE exam_events, answers, results, attempt_questions, exam_sessions, attempts,
             question_options, questions, question_pools, quizzes, sessions, user_roles,
             role_permissions, roles, permissions, users, audit_logs RESTART IDENTITY CASCADE`);
  await redis.flushdb();
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.create({ data: { key, description: PERMISSIONS[key] } });
  }
  const perms = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));
  for (const name of ROLES) {
    const role = await prisma.role.create({ data: { name, isSystem: true } });
    await prisma.rolePermission.createMany({
      data: DEFAULT_ROLE_PERMISSIONS[name].map((k) => ({ roleId: role.id, permissionId: perms.get(k)! })),
    });
  }
}

let counter = 0;
const PASSWORD = 'correct-horse-battery';

export async function createUser(role: RoleName, overrides: { email?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  counter++;
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { name: role } });
  return prisma.user.create({
    data: {
      email: overrides.email ?? `${role.toLowerCase()}${counter}-${Date.now()}@test.local`,
      fullName: `${role} ${counter}`,
      passwordHash: await hashPassword(PASSWORD),
      status: overrides.status ?? 'ACTIVE',
      roles: { create: [{ roleId: roleRow.id }] },
    },
  });
}

export interface Client {
  userId: string;
  headers: Record<string, string>;
  inject: (opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<LightMyRequestResponse>;
}

/** Log in through the real endpoint and return a client that sends the session cookie. */
export async function login(email: string, password = PASSWORD): Promise<Client> {
  const a = await getApp();
  const res = await a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const headers = { cookie, origin: 'http://localhost:3000' };
  return {
    userId: res.json().data.user.id,
    headers,
    inject: (opts) =>
      a.inject({
        method: opts.method as 'GET',
        url: opts.url,
        payload: opts.payload as object,
        headers: { ...headers, ...(opts.headers ?? {}) },
      }),
  };
}

export async function userClient(role: RoleName) {
  const u = await createUser(role);
  return { user: u, client: await login(u.email) };
}

export interface QuizOpts {
  durationSeconds?: number;
  resultsVisibility?: 'IMMEDIATE' | 'AFTER_END' | 'HIDDEN';
  maxAttempts?: number;
  shuffle?: boolean;
  violationThreshold?: number;
}

/** Build a quiz through the admin API and bring it to ACTIVE. */
export async function createActiveQuiz(admin: Client, opts: QuizOpts = {}) {
  const created = await admin.inject({
    method: 'POST',
    url: '/api/v1/admin/quizzes',
    payload: {
      title: 'Test quiz',
      durationSeconds: opts.durationSeconds ?? 600,
      resultsVisibility: opts.resultsVisibility ?? 'IMMEDIATE',
      maxAttempts: opts.maxAttempts ?? 1,
      shuffleQuestions: opts.shuffle ?? true,
      shuffleOptions: opts.shuffle ?? true,
      violationThreshold: opts.violationThreshold ?? 5,
    },
  });
  if (created.statusCode !== 201) throw new Error(`create quiz failed: ${created.body}`);
  const quizId: string = created.json().data.id;

  const q = await admin.inject({
    method: 'POST',
    url: `/api/v1/admin/quizzes/${quizId}/questions`,
    payload: {
      questions: [
        {
          type: 'SINGLE_CHOICE',
          prompt: '2 + 2 = ?',
          points: 1,
          negativePoints: 0.25,
          options: [
            { text: '3', isCorrect: false },
            { text: '4', isCorrect: true },
            { text: '5', isCorrect: false },
          ],
        },
        {
          type: 'MULTIPLE_CHOICE',
          prompt: 'Select even numbers',
          points: 2,
          options: [
            { text: '2', isCorrect: true },
            { text: '3', isCorrect: false },
            { text: '8', isCorrect: true },
          ],
        },
        { type: 'SHORT_TEXT', prompt: 'Capital of France?', points: 1, acceptedAnswers: ['Paris'] },
      ],
    },
  });
  if (q.statusCode !== 201) throw new Error(`create questions failed: ${q.body}`);

  for (const action of ['publish', 'activate']) {
    const r = await admin.inject({ method: 'POST', url: `/api/v1/admin/quizzes/${quizId}/${action}` });
    if (r.statusCode !== 200) throw new Error(`${action} failed: ${r.body}`);
  }
  return { quizId };
}

export async function startAttempt(student: Client, quizId: string) {
  const res = await student.inject({ method: 'POST', url: '/api/v1/attempts', payload: { quizId } });
  if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`start failed: ${res.statusCode} ${res.body}`);
  const data = res.json().data;
  return {
    attemptId: data.attempt.id as string,
    examSessionId: data.examSessionId as string,
    questions: data.questions as { questionId: string; type: string; prompt: string; options: { id: string; text: string }[] }[],
    raw: data,
  };
}

/** Correct answer payloads, looked up from the DB (as the grader would). */
export async function correctResponses(quizId: string) {
  const qs = await prisma.question.findMany({ where: { quizId }, include: { options: true } });
  return new Map(
    qs.map((q) => [
      q.id,
      q.type === 'SHORT_TEXT'
        ? { text: q.acceptedAnswers[0]! }
        : { selectedOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id) },
    ]),
  );
}

/** Move an attempt's server-side deadline into the past (simulates time running out). */
export async function expireAttempt(attemptId: string, secondsAgo = 120) {
  const now = Date.now();
  await prisma.attempt.update({
    where: { id: attemptId },
    data: { startedAt: new Date(now - 3600_000), expiresAt: new Date(now - secondsAgo * 1000) },
  });
  await refreshAttemptMeta(attemptId);
}

export const examHeaders = (examSessionId: string) => ({ 'x-exam-session-id': examSessionId });
