import { z } from 'zod';
import { PageQuery } from '../../utils/pagination.js';

const DateTime = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const QuizFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullish(),
  instructions: z.string().trim().max(20000).nullish(),
  durationSeconds: z.number().int().min(60).max(24 * 3600),
  startsAt: DateTime.nullish(),
  endsAt: DateTime.nullish(),
  maxAttempts: z.number().int().min(1).max(20),
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  passingPercentage: z.number().min(0).max(100).nullish(),
  resultsVisibility: z.enum(['IMMEDIATE', 'AFTER_END', 'HIDDEN']),
  violationThreshold: z.number().int().min(1).max(1000),
};

const windowValid = (v: { startsAt?: Date | null; endsAt?: Date | null }) =>
  !(v.startsAt && v.endsAt) || v.endsAt > v.startsAt;

export const CreateQuizBody = z
  .object({
    ...QuizFields,
    maxAttempts: QuizFields.maxAttempts.default(1),
    shuffleQuestions: QuizFields.shuffleQuestions.default(true),
    shuffleOptions: QuizFields.shuffleOptions.default(true),
    resultsVisibility: QuizFields.resultsVisibility.default('AFTER_END'),
    violationThreshold: QuizFields.violationThreshold.default(5),
  })
  .strict()
  .refine(windowValid, { message: 'endsAt must be after startsAt', path: ['endsAt'] });

export const UpdateQuizBody = z
  .object(QuizFields)
  .partial()
  .strict()
  .refine(windowValid, { message: 'endsAt must be after startsAt', path: ['endsAt'] });

export const QuizIdParams = z.object({ quizId: z.uuid() });

export const AdminQuizListQuery = PageQuery.extend({
  status: z.enum(['DRAFT', 'PUBLISHED', 'ACTIVE', 'ENDED', 'ARCHIVED']).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

export const PoolBody = z.object({
  name: z.string().trim().min(1).max(100),
  drawCount: z.number().int().min(1).max(1000),
}).strict();

export const PoolIdParams = z.object({ poolId: z.uuid() });
