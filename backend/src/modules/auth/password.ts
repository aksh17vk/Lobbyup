import { hash, verify } from '@node-rs/argon2';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

// Argon2id (algorithm 2). Hashing runs on the libuv threadpool, off the event loop.
const opts = {
  algorithm: 2 as const,
  memoryCost: env.ARGON2_MEMORY_KIB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: 1,
};

/**
 * Cap concurrent Argon2 work so a login storm (or a flood of bogus logins) cannot monopolise
 * a small instance's CPU and starve exam autosaves. Excess requests wait in a bounded queue;
 * beyond that they get a retryable 503.
 */
let active = 0;
const waiting: (() => void)[] = [];

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= env.ARGON2_MAX_CONCURRENCY) {
    if (waiting.length >= env.ARGON2_MAX_QUEUE) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Login is busy. Please retry in a few seconds.', { retryAfterSeconds: 3 });
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot over directly
    else active--;
  }
}

export const hashPassword = (plain: string) => withHashSlot(() => hash(plain, opts));

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  return withHashSlot(async () => {
    try {
      return await verify(passwordHash, plain);
    } catch {
      return false;
    }
  });
}

let dummyHash: Promise<string> | null = null;
/** Burn equivalent CPU when the user does not exist, so timing does not reveal valid emails. */
export async function verifyAgainstDummy(plain: string): Promise<void> {
  dummyHash ??= hash('lobbyup-dummy-password-for-timing', opts);
  await verifyPassword(await dummyHash, plain);
}
