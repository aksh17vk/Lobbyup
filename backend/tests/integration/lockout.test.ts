/**
 * Lockout accounting, observed at the password-verification boundary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ calls: 0, failNext: 0 }));

vi.mock('../../src/modules/auth/password.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/auth/password.js')>();
  const { AppError } = await import('../../src/utils/errors.js');
  return {
    ...real,
    verifyPassword: async (hash: string, plain: string) => {
      control.calls++;
      if (control.failNext > 0) {
        control.failNext--;
        throw new AppError('SERVICE_UNAVAILABLE', 'Login is busy. Please retry in a few seconds.');
      }
      return real.verifyPassword(hash, plain);
    },
  };
});

const { closeApp, createUser, getApp, prisma, resetDb } = await import('../helpers.js');

describe('login lockout accounting', () => {
  beforeAll(async () => {
    await resetDb();
    await getApp();
  });
  afterAll(closeApp);

  it('concurrent guesses: at most LOGIN_MAX_FAILURES passwords are actually verified', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    control.calls = 0;
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: `guess-${i}` } }),
      ),
    );
    expect(control.calls).toBeLessThanOrEqual(5); // LOGIN_MAX_FAILURES in vitest.config.ts
  });

  it('a retryable 503 during verification does not count towards the lockout', async () => {
    const u = await createUser('STUDENT');
    const app = await getApp();
    control.failNext = 8;
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
      expect(r.statusCode).toBe(503);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'correct-horse-battery' } });
    expect(ok.statusCode).toBe(200);
  });
});
