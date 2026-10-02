import type { z } from 'zod';
import { AppError } from './errors.js';

/** Parse untrusted input with a Zod schema; throws a standard VALIDATION_ERROR on failure. */
export function parse<S extends z.ZodType>(schema: S, input: unknown, where = 'body'): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Invalid request ${where}.`,
      result.error.issues.slice(0, 20).map((i) => ({
        path: [where, ...i.path.map(String)].join('.'),
        message: i.message,
      })),
    );
  }
  return result.data;
}
