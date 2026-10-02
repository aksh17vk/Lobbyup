import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { audit } from '../../utils/audit.js';
import { AppError, forbidden, notFound } from '../../utils/errors.js';
import { PageQuery, skipTake } from '../../utils/pagination.js';
import { Email, Password } from '../auth/auth.schemas.js';
import { hashPassword } from '../auth/password.js';
import { isSuperAdmin, type AuthContext } from '../permissions/authorize.js';
import { ROLES, SELF_SERVICE_PERMISSIONS } from '../permissions/catalog.js';
import { invalidateSessionCacheForUsers, revokeAllSessions } from '../sessions/session.service.js';
import { mapLimit } from '../../utils/concurrency.js';

const RoleName = z.enum(ROLES);

/** Institutional student number: trimmed, 1–64 chars of letters, digits and . _ - / */
export const StudentId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._/-]+$/, 'studentId may only contain letters, digits and . _ - /');

export const CreateUserItem = z
  .object({
    email: Email,
    fullName: z.string().trim().min(1).max(200),
    studentId: StudentId.optional(),
    password: Password,
    roles: z.array(RoleName).min(1).max(4).default(['STUDENT']),
  })
  .strict();

export const CreateUsersBody = z.union([
  CreateUserItem,
  z.object({ users: z.array(CreateUserItem).min(1).max(500) }).strict(),
]);

export const UpdateUserBody = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    studentId: StudentId.nullable().optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  })
  .strict();

export const SetRolesBody = z.object({ roles: z.array(RoleName).min(1).max(4) }).strict();
export const ResetPasswordBody = z.object({ newPassword: Password }).strict();
export const UserListQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  role: RoleName.optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
});
export const UserIdParams = z.object({ userId: z.uuid() });

const publicUser = {
  id: true,
  email: true,
  studentId: true,
  fullName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { name: true } } } },
} satisfies Prisma.UserSelect;

const shape = (u: Prisma.UserGetPayload<{ select: typeof publicUser }>) => ({
  ...u,
  roles: u.roles.map((r) => r.role.name),
});


async function permissionsOfRoles(roleNames: string[]) {
  const rps = await prisma.rolePermission.findMany({
    where: { role: { name: { in: roleNames } } },
    select: { permission: { select: { key: true } } },
  });
  return new Set(rps.map((r) => r.permission.key));
}

function missingPermissions(auth: AuthContext, perms: Set<string>) {
  return [...perms].filter((p) => !SELF_SERVICE_PERMISSIONS.has(p) && !auth.permissions.has(p));
}

/**
 * Prevent privilege escalation: a non-super-admin may only grant roles whose permissions they
 * already hold themselves (same rule as editing role permissions). Only super admins grant SUPER_ADMIN.
 */
async function assertCanGrant(auth: AuthContext, roles: string[]) {
  if (isSuperAdmin(auth)) return;
  if (roles.includes('SUPER_ADMIN')) throw forbidden('Only a super admin can grant the SUPER_ADMIN role.');
  const missing = missingPermissions(auth, await permissionsOfRoles(roles));
  if (missing.length) throw forbidden(`You cannot grant roles carrying permissions you do not hold: ${missing.join(', ')}`);
}

async function roleIds(names: string[]) {
  const roles = await prisma.role.findMany({ where: { name: { in: names } } });
  if (roles.length !== new Set(names).size) throw new AppError('VALIDATION_ERROR', 'Unknown role.');
  return roles.map((r) => r.id);
}

export async function createUsers(auth: AuthContext, items: z.output<typeof CreateUserItem>[]) {
  for (const u of items) {
    // Granting non-student roles while creating requires MANAGE_ROLES as well.
    if (u.roles.some((r) => r !== 'STUDENT') && !auth.permissions.has('MANAGE_ROLES')) throw forbidden();
  }
  await assertCanGrant(auth, [...new Set(items.flatMap((u) => u.roles))]);
  const emails = items.map((i) => i.email);
  if (new Set(emails).size !== emails.length) throw new AppError('VALIDATION_ERROR', 'Duplicate emails in request.');
  const existing = await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } });
  if (existing.length) throw new AppError('CONFLICT', 'Some emails already exist.', { emails: existing.map((e) => e.email) });
  const studentIds = items.map((i) => i.studentId).filter((x): x is string => !!x);
  if (new Set(studentIds).size !== studentIds.length) throw new AppError('VALIDATION_ERROR', 'Duplicate studentIds in request.');
  if (studentIds.length) {
    const taken = await prisma.user.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true } });
    if (taken.length) throw new AppError('CONFLICT', 'Some studentIds already exist.', { studentIds: taken.map((t) => t.studentId) });
  }

  const roleMap = new Map((await prisma.role.findMany()).map((r) => [r.name, r.id]));
  const hashes = await mapLimit(items, 4, (u) => hashPassword(u.password));

  const created = await prisma.$transaction(
    items.map((u, i) =>
      prisma.user.create({
        data: {
          email: u.email,
          studentId: u.studentId ?? null,
          fullName: u.fullName,
          passwordHash: hashes[i]!,
          roles: { create: u.roles.map((r) => ({ roleId: roleMap.get(r)! })) },
        },
        select: publicUser,
      }),
    ),
  );
  await audit(auth.userId, 'user.create', 'user', null, { count: created.length });
  return created.map(shape);
}

export async function listUsers(q: z.output<typeof UserListQuery>) {
  const where: Prisma.UserWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.role ? { roles: { some: { role: { name: q.role } } } } : {}),
    ...(q.q
      ? {
          OR: [
            { email: { contains: q.q, mode: 'insensitive' } },
            { fullName: { contains: q.q, mode: 'insensitive' } },
            { studentId: { contains: q.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, select: publicUser, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
    prisma.user.count({ where }),
  ]);
  return { items: items.map(shape), total };
}

async function getTarget(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: publicUser });
  if (!u) throw notFound('User');
  return shape(u);
}

/**
 * A non-super-admin may only modify (reset password, suspend, change roles, revoke sessions) users
 * whose permissions they hold themselves — otherwise a user manager could take over a more
 * privileged account by resetting its password.
 */
async function assertCanModify(auth: AuthContext, target: { id: string; roles: string[] }) {
  if (isSuperAdmin(auth)) return;
  if (target.roles.includes('SUPER_ADMIN')) throw forbidden('Cannot modify a super admin.');
  if (target.id === auth.userId) return;
  if (missingPermissions(auth, await permissionsOfRoles(target.roles)).length) {
    throw forbidden('Cannot modify a user with permissions you do not hold.');
  }
}

export async function updateUser(auth: AuthContext, userId: string, input: z.output<typeof UpdateUserBody>) {
  const target = await getTarget(userId);
  await assertCanModify(auth, target);
  if (userId === auth.userId && input.status && input.status !== 'ACTIVE') {
    throw new AppError('BAD_REQUEST', 'You cannot deactivate your own account.');
  }
  const u = await prisma.user.update({ where: { id: userId }, data: input, select: publicUser });
  if (input.status && input.status !== 'ACTIVE') await revokeAllSessions(userId);
  await audit(auth.userId, 'user.update', 'user', userId, input);
  return shape(u);
}

export async function setUserRoles(auth: AuthContext, userId: string, roles: string[]) {
  const target = await getTarget(userId);
  await assertCanModify(auth, target);
  await assertCanGrant(auth, roles);
  if (userId === auth.userId && target.roles.includes('SUPER_ADMIN') && !roles.includes('SUPER_ADMIN')) {
    throw new AppError('BAD_REQUEST', 'You cannot remove your own SUPER_ADMIN role.');
  }
  const ids = await roleIds(roles);
  await prisma.$transaction([
    prisma.userRole.deleteMany({ where: { userId } }),
    prisma.userRole.createMany({ data: ids.map((roleId) => ({ userId, roleId })) }),
  ]);
  await invalidateSessionCacheForUsers([userId]);
  await audit(auth.userId, 'user.roles', 'user', userId, { from: target.roles, to: roles });
  return getTarget(userId);
}

export async function resetPassword(auth: AuthContext, userId: string, newPassword: string) {
  const target = await getTarget(userId);
  await assertCanModify(auth, target);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), failedLoginCount: 0, lockedUntil: null },
  });
  await revokeAllSessions(userId);
  await audit(auth.userId, 'user.reset_password', 'user', userId);
}

export async function revokeUserSessions(auth: AuthContext, userId: string) {
  const target = await getTarget(userId);
  await assertCanModify(auth, target);
  const n = await revokeAllSessions(userId);
  await audit(auth.userId, 'user.revoke_sessions', 'user', userId, { count: n });
  return n;
}

