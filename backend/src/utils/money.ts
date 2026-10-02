import { Prisma } from '@prisma/client';

/**
 * Scores are handled in integer hundredths to avoid floating point drift
 * (e.g. 0.25 negative marking × 100 questions).
 */
export const toCents = (v: Prisma.Decimal | number | string): number =>
  Math.round(Number(v.toString()) * 100);

export const fromCents = (c: number): number => c / 100;
