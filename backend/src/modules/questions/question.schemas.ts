import { z } from 'zod';

const Points = z.number().min(0).max(1000).multipleOf(0.01);

export const QuestionInput = z
  .object({
    type: z.enum(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'SHORT_TEXT']),
    prompt: z.string().trim().min(1).max(10000),
    points: Points.default(1),
    negativePoints: Points.default(0),
    poolId: z.uuid().nullish(),
    position: z.number().int().min(0).max(100000).optional(),
    options: z
      .array(z.object({ text: z.string().trim().min(1).max(2000), isCorrect: z.boolean() }).strict())
      .max(20)
      .default([]),
    acceptedAnswers: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict()
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.isCorrect).length;
    if (q.type === 'SHORT_TEXT') {
      if (q.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'SHORT_TEXT takes no options' });
      if (!q.acceptedAnswers.length)
        ctx.addIssue({ code: 'custom', path: ['acceptedAnswers'], message: 'At least one accepted answer is required' });
      return;
    }
    if (q.acceptedAnswers.length)
      ctx.addIssue({ code: 'custom', path: ['acceptedAnswers'], message: 'Only SHORT_TEXT takes accepted answers' });
    if (q.options.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'At least two options are required' });
    if (q.type === 'SINGLE_CHOICE' && correct !== 1)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Exactly one option must be correct' });
    if (q.type === 'MULTIPLE_CHOICE' && correct < 1)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'At least one option must be correct' });
  });

export type QuestionInputT = z.output<typeof QuestionInput>;

export const CreateQuestionsBody = z.union([
  QuestionInput,
  z.object({ questions: z.array(QuestionInput).min(1).max(500) }).strict(),
]);

export const QuestionIdParams = z.object({ questionId: z.uuid() });
