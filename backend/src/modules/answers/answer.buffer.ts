import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { mapLimit } from '../../utils/concurrency.js';
import { logger } from '../../utils/logger.js';
import { isDataError, persistAnswers, type StoredAnswer } from './answer.repository.js';

const FLUSH_CONCURRENCY = 4;
const KEEP_AFTER_EXPIRY_MS = 24 * 3600_000;

export type ItemStatus = 'accepted' | 'duplicate' | 'stale';
export type BufferOutcome =
  | { ok: true; items: { status: ItemStatus; serverRevision: number }[] }
  | { ok: false; reason: 'META_MISSING' | 'NOT_IN_PROGRESS' | 'EXPIRED' | 'WRONG_SESSION' };

/** Atomic, state-checked save into the Redis buffer (see SAVE_ANSWERS in db/redis.ts). */
export async function bufferAnswers(
  attemptId: string,
  expiresAt: number,
  examSessionId: string,
  items: StoredAnswer[],
): Promise<BufferOutcome> {
  const args: (string | number)[] = [
    keys.attemptMeta(attemptId),
    keys.attemptAnswers(attemptId),
    keys.dirtyAttempts(),
    keys.attemptChanged(attemptId),
    Date.now(),
    env.SUBMIT_GRACE_SECONDS * 1000,
    examSessionId,
    attemptId,
    expiresAt + KEEP_AFTER_EXPIRY_MS,
  ];
  for (const it of items) {
    args.push(
      it.questionId,
      String(it.revision),
      JSON.stringify({ r: it.response, c: it.clientSavedAt, s: it.serverSavedAt, x: it.examSessionId ?? null }),
    );
  }
  const res = await redis.luSaveAnswers(...args);

  const code = Number(res[0]);
  if (code === -1) return { ok: false, reason: 'META_MISSING' };
  if (code === -2) return { ok: false, reason: 'NOT_IN_PROGRESS' };
  if (code === -3) return { ok: false, reason: 'EXPIRED' };
  if (code === -4) return { ok: false, reason: 'WRONG_SESSION' };

  const out: { status: ItemStatus; serverRevision: number }[] = [];
  for (let i = 1; i < res.length; i += 2) {
    const s = Number(res[i]);
    out.push({ status: s === 1 ? 'accepted' : s === 0 ? 'duplicate' : 'stale', serverRevision: Number(res[i + 1]) });
  }
  return { ok: true, items: out };
}

function decode(questionId: string, raw: string): StoredAnswer {
  const bar = raw.indexOf('|');
  const v = JSON.parse(raw.slice(bar + 1)) as { r: StoredAnswer['response']; c: string | null; s: string; x?: string | null };
  return {
    questionId,
    revision: Number(raw.slice(0, bar)),
    response: v.r,
    clientSavedAt: v.c,
    serverSavedAt: v.s,
    examSessionId: v.x ?? null,
  };
}

export async function readBufferedAnswers(attemptId: string): Promise<StoredAnswer[]> {
  const h = await redis.hgetall(keys.attemptAnswers(attemptId));
  return Object.entries(h).map(([q, raw]) => decode(q, raw));
}

/**
 * Persist a batch; if Postgres rejects the batch because a row is unstorable (data exception),
 * retry row by row and quarantine only the offending rows, so one bad value can never block an
 * attempt's flush (and therefore its submission). Connection errors still propagate.
 */
async function persistIsolatingBadRows(attemptId: string, items: StoredAnswer[]) {
  try {
    return (await persistAnswers(attemptId, items)).length;
  } catch (err) {
    if (!isDataError(err)) throw err;
    let n = 0;
    for (const it of items) {
      try {
        n += (await persistAnswers(attemptId, [it])).length;
      } catch (e) {
        if (!isDataError(e)) throw e;
        await quarantine(attemptId, it, e);
      }
    }
    return n;
  }
}

/** Remove one buffered value — only if it is still that revision (a newer save is left alone). */
async function quarantine(attemptId: string, item: StoredAnswer, err: unknown) {
  logger.error({ err, attemptId, questionId: item.questionId, revision: item.revision }, 'unstorable answer quarantined');
  await redis.luQuarantine(keys.attemptAnswers(attemptId), item.questionId, String(item.revision)).catch(() => {});
}

type SupersededMap = Map<string, Map<string, number>>; // attemptId → examSessionId → endedAt ms

async function loadSuperseded(attemptIds: string[]): Promise<SupersededMap> {
  const rows = await prisma.examSession.findMany({
    where: { attemptId: { in: attemptIds }, status: 'SUPERSEDED' },
    select: { id: true, attemptId: true, endedAt: true },
  });
  const map: SupersededMap = new Map();
  for (const r of rows) {
    if (!map.has(r.attemptId)) map.set(r.attemptId, new Map());
    map.get(r.attemptId)!.set(r.id, r.endedAt?.getTime() ?? 0);
  }
  return map;
}

/**
 * Backstop for the takeover fence: writes made by an exam session AFTER it was superseded
 * (possible only if the fence could not be written, e.g. a takeover during a Redis outage) are
 * never persisted or graded. Timestamps come from different servers, so a small clock-skew margin
 * keeps writes made right around the takeover.
 */
const SUPERSEDE_SKEW_MS = 2000;

async function dropSupersededWrites(attemptId: string, items: StoredAnswer[], superseded: SupersededMap) {
  const ended = superseded.get(attemptId);
  if (!ended?.size) return items;
  const keep: StoredAnswer[] = [];
  for (const it of items) {
    const endedAt = it.examSessionId ? ended.get(it.examSessionId) : undefined;
    if (endedAt !== undefined && Date.parse(it.serverSavedAt) > endedAt + SUPERSEDE_SKEW_MS) {
      logger.warn({ attemptId, questionId: it.questionId, examSessionId: it.examSessionId }, 'dropping write from superseded exam session');
      await redis.luQuarantine(keys.attemptAnswers(attemptId), it.questionId, String(it.revision)).catch(() => {});
    } else keep.push(it);
  }
  return keep;
}

/** Persist everything buffered for one attempt (used by finalisation). Idempotent. */
export async function flushAttemptBuffer(attemptId: string): Promise<number> {
  const items = await readBufferedAnswers(attemptId);
  if (!items.length) return 0;
  return persistIsolatingBadRows(attemptId, await dropSupersededWrites(attemptId, items, await loadSuperseded([attemptId])));
}

/**
 * Background flush for one attempt: only questions changed since the last flush are taken
 * (atomically) and written. On failure they are put back so nothing is lost.
 */
async function flushChanged(attemptId: string) {
  const flat = await redis.luTakeChanged(keys.attemptChanged(attemptId), keys.attemptAnswers(attemptId));
  if (!flat.length) return;
  const items: StoredAnswer[] = [];
  for (let i = 0; i < flat.length; i += 2) items.push(decode(flat[i]!, flat[i + 1]!));
  try {
    // Supersession is looked up AFTER the take, so a takeover that happened meanwhile is seen.
    const superseded = await loadSuperseded([attemptId]);
    await persistIsolatingBadRows(attemptId, await dropSupersededWrites(attemptId, items, superseded));
  } catch (err) {
    await redis.sadd(keys.attemptChanged(attemptId), ...items.map((i) => i.questionId)).catch(() => {});
    throw err;
  }
}

/** Drain up to `batch` dirty attempts. Used by the background flush worker. */
export async function flushDirtyAttempts(batch = 200): Promise<{ attempts: number; failed: number }> {
  const ids = (await redis.spop(keys.dirtyAttempts(), batch)) as string[];
  if (!ids.length) return { attempts: 0, failed: 0 };
  let failed = 0;
  // Bounded concurrency so the flush never starves API requests of DB connections.
  await mapLimit(ids, FLUSH_CONCURRENCY, async (id) => {
    try {
      await flushChanged(id);
    } catch (err) {
      failed++;
      logger.warn({ err, attemptId: id }, 'answer flush failed; re-queued');
      await redis.sadd(keys.dirtyAttempts(), id).catch(() => {});
    }
  });
  return { attempts: ids.length, failed };
}

export async function dropAttemptBuffer(attemptId: string) {
  await redis.del(keys.attemptAnswers(attemptId), keys.attemptChanged(attemptId)).catch(() => {});
}
