import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import type { AuthContext } from '../permissions/authorize.js';
import { createSession, revokeAllSessions } from '../sessions/session.service.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';

const INVALID = () => new AppError('INVALID_CREDENTIALS', 'Invalid email or password.');

/**
 * Password check with per-account lockout, shared by login and password change.
 *
 * Each check atomically reserves a failure slot BEFORE the expensive verification
 * (UPDATE … SET failed_login_count = failed_login_count + 1 … RETURNING), so concurrent guesses
 * cannot share one slot. If the verification itself cannot run (busy hash queue, infrastructure
 * error) the slot is refunded, so a retryable error never counts towards a lockout.
 * A locked account answers exactly like a wrong password (same error, same Argon2 cost), so the
 * lock state does not reveal which emails exist.
 */
async function checkPasswordWithLockout(user: { id: string; passwordHash: string }, password: string) {
  const reserved = await prisma.$queryRaw<{ failed_login_count: number }[]>`
    UPDATE users SET failed_login_count = failed_login_count + 1
     WHERE id = ${user.id}::uuid AND (locked_until IS NULL OR locked_until <= now())
    RETURNING failed_login_count`;
  const attemptNo = reserved[0]?.failed_login_count;

  if (attemptNo === undefined || attemptNo > env.LOGIN_MAX_FAILURES) {
    // Locked, or the failure budget was already used up by concurrent attempts.
    if (attemptNo !== undefined) await lock(user.id);
    await verifyAgainstDummy(password);
    throw INVALID();
  }

  let ok: boolean;
  try {
    ok = await verifyPassword(user.passwordHash, password);
  } catch (err) {
    await prisma.$executeRaw`
      UPDATE users SET failed_login_count = GREATEST(failed_login_count - 1, 0) WHERE id = ${user.id}::uuid`.catch(() => {});
    throw err;
  }
  if (!ok) {
    if (attemptNo >= env.LOGIN_MAX_FAILURES) await lock(user.id);
    throw INVALID();
  }
  // Password proven: settle the reservation now, so no later failure (inactive account, DB error,
  // busy hash queue while setting a new password) can leave a charge behind.
  await prisma.$executeRaw`UPDATE users SET failed_login_count = 0 WHERE id = ${user.id}::uuid`;
}

export async function login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await verifyAgainstDummy(password);
    throw INVALID();
  }
  await checkPasswordWithLockout(user, password);

  // Status is checked only after the password so it cannot be used to enumerate accounts.
  if (user.status !== 'ACTIVE') throw new AppError('ACCOUNT_INACTIVE', 'This account is not active.');

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  const { token, session } = await createSession(user.id, meta);
  return { token, session, user };
}

async function lock(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) },
  });
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
  });
  const permissions = new Set<string>();
  for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
  return {
    id: user.id,
    email: user.email,
    studentId: user.studentId,
    fullName: user.fullName,
    status: user.status,
    roles: user.roles.map((r) => r.role.name),
    permissions: [...permissions].sort(),
    lastLoginAt: user.lastLoginAt,
  };
}

/** Cheap identity for GET /auth/me, served from the (cached) server-side auth context. */
export function meFromContext(auth: AuthContext) {
  return {
    id: auth.userId,
    email: auth.email,
    studentId: auth.studentId,
    fullName: auth.fullName,
    status: 'ACTIVE' as const,
    roles: auth.roles,
    permissions: [...auth.permissions].sort(),
    sessionId: auth.sessionId,
  };
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  // Same lockout as login, so a hijacked session cannot brute-force the current password.
  await checkPasswordWithLockout(user, current);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(next), failedLoginCount: 0, lockedUntil: null },
  });
  // Sign out every other device.
  await revokeAllSessions(userId, sessionId);
}
