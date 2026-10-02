import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  // Query errors are surfaced (and logged once) by the API error handler; expected races such as
  // unique-index collisions on concurrent starts are handled in code and should not spam logs.
  log: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn'],
  // Bursts (e.g. 500 submits at the bell) can queue for a connection; wait rather than fail.
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
});

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** True when a Prisma error is a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string } };
  // P2002 = Prisma unique violation; 23505 = raw Postgres unique violation via $executeRaw
  return e.code === 'P2002' || e.meta?.code === '23505' || (e.code === 'P2010' && e.meta?.code === '23505');
}
