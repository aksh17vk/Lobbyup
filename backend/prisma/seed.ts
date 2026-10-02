/**
 * Idempotent seed:
 *   - permissions catalogue and the four system roles
 *   - default role → permission mapping (only applied when a role is first created, so
 *     later edits made through MANAGE_ROLES are preserved; SUPER_ADMIN always gets everything)
 *   - the first SUPER_ADMIN from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   - optional demo data with SEED_DEMO=true (never in production)
 */
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES } from '../src/modules/permissions/catalog.js';

const prisma = new PrismaClient();
const hashPassword = (p: string) => hash(p, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });

async function seedRbac() {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: { description: PERMISSIONS[key] },
      create: { key, description: PERMISSIONS[key] },
    });
  }
  const perms = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));

  for (const name of ROLES) {
    const existing = await prisma.role.findUnique({ where: { name } });
    const role = existing ?? (await prisma.role.create({ data: { name, isSystem: true } }));
    if (!existing || name === 'SUPER_ADMIN') {
      await prisma.rolePermission.createMany({
        data: DEFAULT_ROLE_PERMISSIONS[name].map((k) => ({ roleId: role.id, permissionId: perms.get(k)! })),
        skipDuplicates: true,
      });
    }
  }
  console.log(`✔ ${ALL_PERMISSIONS.length} permissions, ${ROLES.length} roles`);
}

async function ensureUser(email: string, fullName: string, password: string, roleName: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      fullName,
      passwordHash: await hashPassword(password),
      roles: { create: [{ roleId: role.id }] },
    },
  });
}

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('ℹ SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipping super admin.');
    return;
  }
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  await ensureUser(email, 'Super Admin', password, 'SUPER_ADMIN');
  console.log(`✔ super admin ${email}`);
}

async function seedDemo() {
  if (process.env.SEED_DEMO !== 'true') return;
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production.');

  const pw = process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123';
  const examAdmin = await ensureUser('examadmin@lobbyup.test', 'Exam Admin', pw, 'EXAM_ADMIN');
  await ensureUser('proctor@lobbyup.test', 'Proctor', pw, 'PROCTOR');
  for (let i = 1; i <= 5; i++) await ensureUser(`student${i}@lobbyup.test`, `Student ${i}`, pw, 'STUDENT');

  if (!(await prisma.quiz.findFirst({ where: { title: 'Demo: General Knowledge' } }))) {
    await prisma.quiz.create({
      data: {
        title: 'Demo: General Knowledge',
        description: 'A short demo quiz.',
        instructions: 'Answer all questions. Your answers are saved automatically.',
        status: 'ACTIVE',
        durationSeconds: 15 * 60,
        resultsVisibility: 'IMMEDIATE',
        createdById: examAdmin.id,
        publishedAt: new Date(),
        questions: {
          create: [
            {
              type: 'SINGLE_CHOICE',
              prompt: 'What is the capital of India?',
              position: 0,
              options: {
                create: [
                  { text: 'Mumbai', isCorrect: false, position: 0 },
                  { text: 'New Delhi', isCorrect: true, position: 1 },
                  { text: 'Kolkata', isCorrect: false, position: 2 },
                  { text: 'Chennai', isCorrect: false, position: 3 },
                ],
              },
            },
            {
              type: 'MULTIPLE_CHOICE',
              prompt: 'Which of these are prime numbers?',
              position: 1,
              points: 2,
              options: {
                create: [
                  { text: '2', isCorrect: true, position: 0 },
                  { text: '4', isCorrect: false, position: 1 },
                  { text: '7', isCorrect: true, position: 2 },
                  { text: '9', isCorrect: false, position: 3 },
                ],
              },
            },
            {
              type: 'SHORT_TEXT',
              prompt: 'Which planet is known as the Red Planet?',
              position: 2,
              acceptedAnswers: ['Mars'],
            },
          ],
        },
      },
    });
  }
  console.log(`✔ demo users (*@lobbyup.test) and an ACTIVE demo quiz`);
}

try {
  await seedRbac();
  await seedAdmin();
  await seedDemo();
} finally {
  await prisma.$disconnect();
}
