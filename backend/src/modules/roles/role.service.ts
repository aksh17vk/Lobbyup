import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { audit } from '../../utils/audit.js';
import { AppError, forbidden, notFound } from '../../utils/errors.js';
import { isSuperAdmin, type AuthContext } from '../permissions/authorize.js';
import { ALL_PERMISSIONS, PERMISSIONS, SELF_SERVICE_PERMISSIONS } from '../permissions/catalog.js';
import { invalidateSessionCacheForUsers } from '../sessions/session.service.js';

export const RoleIdParams = z.object({ roleId: z.uuid() });
export const SetPermissionsBody = z
  .object({ permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length) })
  .strict();

export async function listRoles() {
  const roles = await prisma.role.findMany({
    orderBy: { name: 'asc' },
    include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    userCount: r._count.users,
    permissions: r.permissions.map((p) => p.permission.key).sort(),
  }));
}

export const listPermissions = () => Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));

/**
 * Replace a role's permission set. Guards against privilege escalation: you can only grant
 * permissions you hold yourself, and SUPER_ADMIN's permissions are fixed.
 */
export async function setRolePermissions(auth: AuthContext, roleId: string, permissions: string[]) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw notFound('Role');
  if (role.name === 'SUPER_ADMIN') throw new AppError('BAD_REQUEST', 'SUPER_ADMIN permissions cannot be changed.');
  const before = await prisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } });

  if (!isSuperAdmin(auth)) {
    // You may only edit a role whose current AND resulting permissions you hold yourself — otherwise
    // a role manager could strip a more privileged role and then pass the user-management checks.
    const touched = new Set([...before.map((b) => b.permission.key), ...permissions]);
    const missing = [...touched].filter((p) => !SELF_SERVICE_PERMISSIONS.has(p) && !auth.permissions.has(p));
    if (missing.length) throw forbidden(`You cannot edit a role involving permissions you do not hold: ${missing.join(', ')}`);
  }

  const perms = await prisma.permission.findMany({ where: { key: { in: permissions } } });
  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId } }),
    prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) }),
  ]);

  const users = await prisma.userRole.findMany({ where: { roleId }, select: { userId: true } });
  await invalidateSessionCacheForUsers(users.map((u) => u.userId));
  await audit(auth.userId, 'role.permissions', 'role', roleId, {
    from: before.map((b) => b.permission.key),
    to: permissions,
  });
  return (await listRoles()).find((r) => r.id === roleId);
}
