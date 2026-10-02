export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  ACCOUNT_INACTIVE: 403,
  ACCOUNT_LOCKED: 423,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  QUIZ_NOT_AVAILABLE: 409,
  QUIZ_NOT_EDITABLE: 409,
  MAX_ATTEMPTS_REACHED: 409,
  ATTEMPT_NOT_IN_PROGRESS: 409,
  ATTEMPT_EXPIRED: 409,
  ATTEMPT_ALREADY_SUBMITTED: 409,
  EXAM_SESSION_REQUIRED: 400,
  EXAM_SESSION_SUPERSEDED: 409,
  EXAM_SESSION_ACTIVE_ELSEWHERE: 409,
  QUESTION_NOT_IN_ATTEMPT: 422,
  INVALID_ANSWER: 422,
  RESULT_NOT_RELEASED: 403,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    statusOverride?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusOverride ?? ErrorCodes[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found.`);
export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError('FORBIDDEN', message);
