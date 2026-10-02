import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { startLoop, type Loop } from './loop.js';

const BATCH = 5000;
const DAY_MS = 24 * 3600_000;

/**
 * Privacy retention (data minimisation). Kept permanently as academic/security records:
 * attempts (status, timing, score, violation score and review decision), answers, results and
 * the audit log. Removed after the retention period:
 *
 *  - DATA_RETENTION_DAYS after an attempt is finished: its proctoring events, all of its
 *    exam-session rows (device metadata, IP, user agent; any still marked ACTIVE are stale) and
 *    the IP stored on the attempt.
 *  - SESSION_RETENTION_DAYS after a login session ended: the session row (IP, user agent),
 *    once no exam session still references it.
 *
 * Deletes run in bounded batches so a large backlog never holds long locks.
 */
export async function runRetention(now = new Date()) {
  const out = { events: 0, examSessions: 0, attemptIps: 0, sessions: 0 };

  if (env.DATA_RETENTION_DAYS > 0) {
    const cutoff = new Date(now.getTime() - env.DATA_RETENTION_DAYS * DAY_MS);
    // Attempts finished before the cutoff (finalisation stamps submitted_at; cancels use updated_at).
    for (;;) {
      const n = await prisma.$executeRaw`
        DELETE FROM exam_events WHERE id IN (
          SELECT e.id FROM exam_events e JOIN attempts a ON a.id = e.attempt_id
           WHERE a.status IN ('SUBMITTED', 'EXPIRED', 'CANCELLED')
             AND COALESCE(a.submitted_at, a.updated_at) < ${cutoff}
           LIMIT ${BATCH})`;
      out.events += n;
      if (n < BATCH) break;
    }
    out.examSessions = await prisma.$executeRaw`
      DELETE FROM exam_sessions x USING attempts a
       WHERE x.attempt_id = a.id
         AND a.status IN ('SUBMITTED', 'EXPIRED', 'CANCELLED')
         AND COALESCE(a.submitted_at, a.updated_at) < ${cutoff}`;
    out.attemptIps = await prisma.$executeRaw`
      UPDATE attempts a SET ip_address = NULL
       WHERE a.ip_address IS NOT NULL
         AND a.status IN ('SUBMITTED', 'EXPIRED', 'CANCELLED')
         AND COALESCE(a.submitted_at, a.updated_at) < ${cutoff}`;
  }

  if (env.SESSION_RETENTION_DAYS > 0) {
    const cutoff = new Date(now.getTime() - env.SESSION_RETENTION_DAYS * DAY_MS);
    out.sessions = await prisma.$executeRaw`
      DELETE FROM sessions s
       WHERE (s.status <> 'ACTIVE' OR s.expires_at < now())
         AND COALESCE(s.revoked_at, LEAST(s.expires_at, s.last_activity_at)) < ${cutoff}
         AND NOT EXISTS (SELECT 1 FROM exam_sessions x WHERE x.auth_session_id = s.id)`;
  }

  if (out.events || out.examSessions || out.attemptIps || out.sessions) logger.info(out, 'retention sweep');
  return out;
}

export function startRetentionWorker(intervalMs: number): Loop {
  // First sweep shortly after boot: instances that sleep or redeploy often must still purge.
  return startLoop('retention', intervalMs, async () => {
    await runRetention();
  }, 60_000);
}
