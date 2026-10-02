/**
 * Seeds N load-test students and one ACTIVE quiz, writing loadtest/fixture.json for k6.
 *   LOADTEST_STUDENTS=500 pnpm loadtest:seed
 * Refuses to run when NODE_ENV=production.
 */
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed load-test data in production.');

const prisma = new PrismaClient();
const N = Number(process.env.LOADTEST_STUDENTS ?? 500);
const QUESTIONS = Number(process.env.LOADTEST_QUESTIONS ?? 40);
const PASSWORD = process.env.LOADTEST_PASSWORD ?? 'loadtest-password-123';
const DOMAIN = 'loadtest.lobbyup.test';

async function main() {
  // Clean previous run.
  const old = await prisma.quiz.findMany({ where: { title: { startsWith: '[LOADTEST]' } }, select: { id: true } });
  if (old.length) {
    const ids = old.map((q) => q.id);
    await prisma.result.deleteMany({ where: { quizId: { in: ids } } });
    await prisma.attempt.deleteMany({ where: { quizId: { in: ids } } });
    await prisma.quiz.deleteMany({ where: { id: { in: ids } } });
  }

  const studentRole = await prisma.role.findUniqueOrThrow({ where: { name: 'STUDENT' } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'EXAM_ADMIN' } });
  // Real production hashing parameters, computed once and shared (fine for test accounts only).
  const passwordHash = await hash(PASSWORD, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const admin = await prisma.user.upsert({
    where: { email: `admin@${DOMAIN}` },
    update: {},
    create: { email: `admin@${DOMAIN}`, fullName: 'Loadtest Admin', passwordHash, roles: { create: [{ roleId: adminRole.id }] } },
  });

  const emails = Array.from({ length: N }, (_, i) => `student${String(i + 1).padStart(4, '0')}@${DOMAIN}`);
  const existing = new Set((await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } })).map((u) => u.email));
  const missing = emails.filter((e) => !existing.has(e));
  for (let i = 0; i < missing.length; i += 100) {
    await prisma.$transaction(
      missing.slice(i, i + 100).map((email, j) =>
        prisma.user.create({
          data: { email, fullName: `Load Student ${i + j + 1}`, passwordHash, roles: { create: [{ roleId: studentRole.id }] } },
        }),
      ),
    );
  }
  await prisma.user.updateMany({ where: { email: { in: emails } }, data: { failedLoginCount: 0, lockedUntil: null } });
  await prisma.session.deleteMany({ where: { user: { email: { endsWith: `@${DOMAIN}` } } } });

  const quiz = await prisma.quiz.create({
    data: {
      title: '[LOADTEST] 40-question exam',
      status: 'ACTIVE',
      durationSeconds: 3600,
      resultsVisibility: 'IMMEDIATE',
      violationThreshold: 10,
      createdById: admin.id,
      publishedAt: new Date(),
      questions: {
        create: Array.from({ length: QUESTIONS }, (_, i) =>
          i % 10 === 9
            ? { type: 'SHORT_TEXT' as const, prompt: `Q${i + 1}: type "answer${i}"`, position: i, acceptedAnswers: [`answer${i}`] }
            : {
                type: (i % 4 === 3 ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE') as 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE',
                prompt: `Q${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit — choose wisely.`,
                position: i,
                negativePoints: 0.25,
                options: {
                  create: [0, 1, 2, 3].map((o) => ({ text: `Option ${o + 1} for Q${i + 1}`, isCorrect: o === 0 || (i % 4 === 3 && o === 2), position: o })),
                },
              },
        ),
      },
    },
  });

  writeFileSync(
    new URL('./fixture.json', import.meta.url),
    JSON.stringify({ quizId: quiz.id, students: N, emailPattern: `studentNNNN@${DOMAIN}`, password: PASSWORD }, null, 2),
  );
  console.log(`✔ ${N} students (${missing.length} new), quiz ${quiz.id} with ${QUESTIONS} questions → loadtest/fixture.json`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
