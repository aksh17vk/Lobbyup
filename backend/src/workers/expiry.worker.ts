import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { finalizeAttempt } from '../modules/submissions/submission.service.js';
import { mapLimit } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';
import { startLoop, type Loop } from './loop.js';

/** A SUBMITTING attempt untouched for this long was interrupted mid-submit (crash/deploy). */
const STUCK_SUBMITTING_MS = 2 * 60_000;

/**
 * Auto-submits attempts whose server-side timer ran out (students who closed the tab,
 * lost power, etc.), and completes submissions interrupted by a crash.
 * Safe with several instances: finalizeAttempt locks the row and is idempotent.
 */
export async function sweepExpiredAttempts(limit = 100) {
  const graceCutoff = new Date(Date.now() - env.SUBMIT_GRACE_SECONDS * 1000);
  const stuckCutoff = new Date(Date.now() - STUCK_SUBMITTING_MS);

  const [expired, stuck] = await Promise.all([
    prisma.attempt.findMany({
      where: { status: 'IN_PROGRESS', expiresAt: { lt: graceCutoff } },
      select: { id: true },
      take: limit,
    }),
    prisma.attempt.findMany({
      where: { status: 'SUBMITTING', updatedAt: { lt: stuckCutoff } },
      select: { id: true },
      take: limit,
    }),
  ]);

  let done = 0;
  await mapLimit(
    [...expired, ...stuck].map((a) => a.id),
    4,
    async (id) => {
      try {
        // The final status (SUBMITTED vs EXPIRED) is decided inside finalizeAttempt from when
        // finalisation began, so interrupted expiries are never mislabelled as submissions.
        await finalizeAttempt(id);
        done++;
      } catch (err) {
        logger.warn({ err, attemptId: id }, 'expiry sweep: finalisation failed; will retry');
      }
    },
  );
  if (done) logger.info({ finalized: done }, 'expiry sweep');
  return done;
}

export function startExpiryWorker(intervalMs: number): Loop {
  return startLoop('expiry', intervalMs, async () => {
    await sweepExpiredAttempts();
  });
}
