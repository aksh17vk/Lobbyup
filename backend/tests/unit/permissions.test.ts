import { describe, expect, it } from 'vitest';
import {
  assertCanManageQuiz,
  assertOwnerOr,
  assertPermission,
  hasAnyPermission,
  hasPermission,
  type AuthContext,
} from '../../src/modules/permissions/authorize.js';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../../src/modules/permissions/catalog.js';

const ctx = (roles: (keyof typeof DEFAULT_ROLE_PERMISSIONS)[], userId = 'u1'): AuthContext => ({
  userId,
  sessionId: 's1',
  email: 'x@test',
  fullName: 'X',
  roles,
  permissions: new Set(roles.flatMap((r) => DEFAULT_ROLE_PERMISSIONS[r])),
  via: 'bearer',
});

describe('RBAC defaults', () => {
  it('super admin holds every permission', () => {
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN)).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('students can only take exams and see their own results', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.STUDENT.sort()).toEqual(['SAVE_ANSWER', 'START_EXAM', 'SUBMIT_EXAM', 'VIEW_OWN_RESULT']);
  });

  it('proctors cannot edit exams or see results', () => {
    const p = ctx(['PROCTOR']);
    expect(hasPermission(p, 'VIEW_VIOLATIONS')).toBe(true);
    expect(hasPermission(p, 'EDIT_EXAM')).toBe(false);
    expect(hasPermission(p, 'VIEW_ALL_RESULTS')).toBe(false);
  });
});

describe('permission checks', () => {
  it('unauthenticated → 401, missing permission → 403', () => {
    expect(() => assertPermission(null, 'START_EXAM')).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(() => assertPermission(ctx(['STUDENT']), 'CREATE_EXAM')).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(assertPermission(ctx(['STUDENT']), 'START_EXAM').userId).toBe('u1');
  });

  it('hasAnyPermission', () => {
    expect(hasAnyPermission(ctx(['STUDENT']), ['VIEW_ALL_RESULTS', 'VIEW_OWN_RESULT'])).toBe(true);
    expect(hasAnyPermission(ctx(['STUDENT']), ['VIEW_ALL_RESULTS'])).toBe(false);
    expect(hasAnyPermission(null, ['VIEW_OWN_RESULT'])).toBe(false);
  });
});

describe('resource ownership', () => {
  it('a permission alone does not grant access to someone else’s resource', () => {
    // Student A has SUBMIT_EXAM, but the attempt belongs to student B → 404 (no id probing).
    expect(() => assertOwnerOr(ctx(['STUDENT'], 'A'), 'B', 'SUBMIT_EXAM', 'VIEW_ATTEMPTS')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it('owner with the own-permission is allowed', () => {
    expect(assertOwnerOr(ctx(['STUDENT'], 'A'), 'A', 'VIEW_OWN_RESULT', 'VIEW_ALL_RESULTS')).toBe('owner');
  });

  it('staff with the any-permission is allowed', () => {
    expect(assertOwnerOr(ctx(['EXAM_ADMIN'], 'admin'), 'A', 'VIEW_OWN_RESULT', 'VIEW_ALL_RESULTS')).toBe('staff');
  });

  it('exam admins manage only their own quizzes; super admins manage all', () => {
    expect(() => assertCanManageQuiz(ctx(['EXAM_ADMIN'], 'a1'), { createdById: 'a2' }, 'EDIT_EXAM')).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(() => assertCanManageQuiz(ctx(['EXAM_ADMIN'], 'a1'), { createdById: 'a1' }, 'EDIT_EXAM')).not.toThrow();
    expect(() => assertCanManageQuiz(ctx(['SUPER_ADMIN'], 'root'), { createdById: 'a2' }, 'EDIT_EXAM')).not.toThrow();
    expect(() => assertCanManageQuiz(ctx(['PROCTOR'], 'a1'), { createdById: 'a1' }, 'EDIT_EXAM')).toThrow();
  });
});
