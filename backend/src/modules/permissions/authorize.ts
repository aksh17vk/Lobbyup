import { AppError, forbidden } from '../../utils/errors.js';
import type { Permission } from './catalog.js';

/** Server-side identity. Built only from the session store — never from client input. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: ReadonlySet<string>;
  /** How the token arrived; cookie-authenticated unsafe requests get CSRF checks. */
  via: 'cookie' | 'bearer';
}

export const isSuperAdmin = (auth: AuthContext) => auth.roles.includes('SUPER_ADMIN');

export function hasPermission(auth: AuthContext | null | undefined, perm: Permission): boolean {
  return !!auth && auth.permissions.has(perm);
}

export function hasAnyPermission(auth: AuthContext | null | undefined, perms: Permission[]): boolean {
  return !!auth && perms.some((p) => auth.permissions.has(p));
}

export function requireAuthContext(auth: AuthContext | null | undefined): AuthContext {
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  return auth;
}

export function assertPermission(auth: AuthContext | null | undefined, ...perms: Permission[]): AuthContext {
  const a = requireAuthContext(auth);
  for (const p of perms) if (!a.permissions.has(p)) throw forbidden();
  return a;
}

/**
 * Resource-level check: the actor either owns the resource and holds `ownPerm`,
 * or holds `anyPerm` which grants access to everyone's resources.
 * Returns 404 (not 403) for foreign resources so ids cannot be probed.
 */
export function assertOwnerOr(
  auth: AuthContext,
  resourceOwnerId: string,
  ownPerm: Permission,
  anyPerm: Permission | Permission[],
  what = 'Resource',
): 'owner' | 'staff' {
  const anyPerms = Array.isArray(anyPerm) ? anyPerm : [anyPerm];
  if (anyPerms.some((p) => auth.permissions.has(p))) return 'staff';
  if (resourceOwnerId === auth.userId && auth.permissions.has(ownPerm)) return 'owner';
  if (resourceOwnerId === auth.userId) throw forbidden();
  throw new AppError('NOT_FOUND', `${what} not found.`);
}

/** Quiz management: exam admins manage quizzes they created; super admins manage all. */
export function assertCanManageQuiz(auth: AuthContext, quiz: { createdById: string }, perm: Permission) {
  assertPermission(auth, perm);
  if (!isSuperAdmin(auth) && quiz.createdById !== auth.userId) {
    throw forbidden('Only the quiz owner or a super admin can modify this quiz.');
  }
}
