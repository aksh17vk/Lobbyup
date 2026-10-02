export const PERMISSIONS = {
  CREATE_EXAM: 'Create quizzes',
  EDIT_EXAM: 'Edit quizzes and cancel attempts',
  DELETE_EXAM: 'Delete draft quizzes',
  PUBLISH_EXAM: 'Publish / activate / end / archive quizzes',
  MANAGE_QUESTIONS: 'Create, edit and delete questions and pools',
  START_EXAM: 'Start or resume an exam attempt',
  SAVE_ANSWER: 'Save answers in own attempt',
  SUBMIT_EXAM: 'Submit own attempt',
  VIEW_OWN_RESULT: 'View own results',
  VIEW_ALL_RESULTS: 'View every result',
  VIEW_ATTEMPTS: 'View all attempts',
  VIEW_VIOLATIONS: 'View anti-cheating events and flags',
  REVIEW_VIOLATIONS: 'Review flagged attempts',
  MANAGE_USERS: 'Create and manage users',
  MANAGE_ROLES: 'Assign roles and edit role permissions',
  SYSTEM_SETTINGS: 'View system status and settings',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = ['SUPER_ADMIN', 'EXAM_ADMIN', 'PROCTOR', 'STUDENT'] as const;
export type RoleName = (typeof ROLES)[number];

/** Default role → permission mapping, applied by the seed. Editable later via MANAGE_ROLES. */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  EXAM_ADMIN: [
    'CREATE_EXAM',
    'EDIT_EXAM',
    'DELETE_EXAM',
    'PUBLISH_EXAM',
    'MANAGE_QUESTIONS',
    'VIEW_ALL_RESULTS',
    'VIEW_ATTEMPTS',
    'VIEW_VIOLATIONS',
    'REVIEW_VIOLATIONS',
  ],
  PROCTOR: ['VIEW_ATTEMPTS', 'VIEW_VIOLATIONS', 'REVIEW_VIOLATIONS'],
  STUDENT: ['START_EXAM', 'SAVE_ANSWER', 'SUBMIT_EXAM', 'VIEW_OWN_RESULT'],
};

/**
 * Self-service permissions: they only let a user act on their own exam, never on anyone else.
 * Managers may grant/keep/remove these without holding them (e.g. create students).
 */
export const SELF_SERVICE_PERMISSIONS: ReadonlySet<string> = new Set<Permission>([
  'START_EXAM',
  'SAVE_ANSWER',
  'SUBMIT_EXAM',
  'VIEW_OWN_RESULT',
]);
