import { z } from 'zod';

export const ChoiceResponse = z
  .object({
    selectedOptionIds: z
      .array(z.uuid())
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, 'selectedOptionIds must be unique'),
  })
  .strict();

/**
 * Postgres jsonb cannot store U+0000 or unpaired UTF-16 surrogates. Anything accepted here must be
 * storable, otherwise one bad answer would block the whole attempt's flush.
 */
export const SafeText = z
  .string()
  .max(2000)
  .refine((s) => !s.includes('\u0000') && s.isWellFormed(), 'Text contains invalid characters');

export const TextResponse = z.object({ text: SafeText }).strict();

export const AnswerResponse = z.union([ChoiceResponse, TextResponse]);
export type AnswerResponseT = z.output<typeof AnswerResponse>;

const AnswerFields = {
  response: AnswerResponse,
  /**
   * Client-side monotonically increasing revision per question (e.g. a counter or Date.now()).
   * The server keeps the highest revision, so out-of-order retries can never overwrite newer work.
   */
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Informational only (never trusted for timing). Normalised to UTC within a sane range. */
  clientSavedAt: z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .refine((d) => !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100, 'clientSavedAt out of range')
    .transform((d) => d.toISOString())
    .optional(),
};

export const SaveAnswerBody = z.object(AnswerFields).strict();

export const SyncAnswerItem = z.object({ questionId: z.uuid(), ...AnswerFields }).strict();

export const SyncBody = z
  .object({
    answers: z
      .array(SyncAnswerItem)
      .max(500)
      .refine((a) => new Set(a.map((x) => x.questionId)).size === a.length, 'Duplicate questionId in batch'),
  })
  .strict();

export const SubmitBody = z
  .object({ answers: SyncBody.shape.answers.optional() })
  .strict();

export const AttemptQuestionParams = z.object({ attemptId: z.uuid(), questionId: z.uuid() });
export const AttemptParams = z.object({ attemptId: z.uuid() });

export type SyncAnswerItemT = z.output<typeof SyncAnswerItem>;
