import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../utils/errors.js';
import { getAttemptMeta, refreshAttemptMeta, refreshAttemptMetaBestEffort, type AttemptMeta } from '../attempts/attempt.cache.js';
import { remainingSeconds, withinDeadline } from '../attempts/timer.js';
import type { AuthContext } from '../permissions/authorize.js';
import { assertCurrentExamSession, assertExamSession, touchExamSession } from '../sessions/exam-session.service.js';
import { scheduleFinalize } from '../submissions/submission.service.js';
import { bufferAnswers, readBufferedAnswers, type ItemStatus } from './answer.buffer.js';
import { loadPersistedAnswers, persistAnswers, type StoredAnswer } from './answer.repository.js';
import type { SyncAnswerItemT } from './answer.schemas.js';

export interface SaveResult {
  questionId: string;
  status: ItemStatus;
  serverRevision: number;
}

/** Validate an answer against the attempt's own question set (never against client claims). */
export function validateAgainstAttempt(meta: AttemptMeta, item: SyncAnswerItemT) {
  const q = meta.qmap[item.questionId];
  if (!q) throw new AppError('QUESTION_NOT_IN_ATTEMPT', 'Question is not part of this attempt.', { questionId: item.questionId });
  const r = item.response;
  if (q.t === 'SHORT_TEXT') {
    if (!('text' in r)) throw new AppError('INVALID_ANSWER', 'This question expects a text answer.', { questionId: item.questionId });
    return;
  }
  if (!('selectedOptionIds' in r)) {
    throw new AppError('INVALID_ANSWER', 'This question expects selectedOptionIds.', { questionId: item.questionId });
  }
  if (q.t === 'SINGLE_CHOICE' && r.selectedOptionIds.length > 1) {
    throw new AppError('INVALID_ANSWER', 'Only one option may be selected.', { questionId: item.questionId });
  }
  const allowed = new Set(q.o);
  if (!r.selectedOptionIds.every((id) => allowed.has(id))) {
    throw new AppError('INVALID_ANSWER', 'Selected option does not belong to this question.', { questionId: item.questionId });
  }
}

function assertWritable(meta: Pick<AttemptMeta, 'attemptId' | 'status' | 'expiresAt'>) {
  if (meta.status === 'SUBMITTED') throw new AppError('ATTEMPT_ALREADY_SUBMITTED', 'This attempt has already been submitted.');
  if (meta.status === 'EXPIRED') throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
  if (meta.status !== 'IN_PROGRESS') throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt is not in progress.');
  if (!withinDeadline(new Date(), new Date(meta.expiresAt), env.SUBMIT_GRACE_SECONDS)) {
    scheduleFinalize(meta.attemptId);
    throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
  }
}

/**
 * Shared by PUT /answers/:questionId, POST /sync and POST /submit.
 * Ownership, attempt state, server-side deadline and exam session are all enforced here.
 */
export async function saveAnswers(
  auth: AuthContext,
  attemptId: string,
  examSessionId: string | undefined,
  items: SyncAnswerItemT[],
): Promise<{ results: SaveResult[]; serverTime: string; remainingSeconds: number }> {
  let meta = await getAttemptMeta(attemptId);
  // Never reveal another student's attempt: 404, not 403.
  if (meta.userId !== auth.userId) throw new AppError('NOT_FOUND', 'Attempt not found.');
  assertWritable(meta);
  meta = await assertCurrentExamSession(meta, examSessionId);
  for (const it of items) validateAgainstAttempt(meta, it);

  const now = new Date();
  const stored: StoredAnswer[] = items.map((it) => ({
    questionId: it.questionId,
    revision: it.revision,
    response: it.response,
    clientSavedAt: it.clientSavedAt ?? null,
    serverSavedAt: now.toISOString(),
    examSessionId,
  }));

  let results: SaveResult[];
  if (env.ANSWER_BUFFER === 'direct') {
    results = await saveDirect(attemptId, examSessionId!, stored);
  } else {
    try {
      results = await saveBuffered(attemptId, meta, examSessionId!, stored);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Redis unavailable → write straight to Postgres, which enforces state + deadline in SQL.
      results = await saveDirect(attemptId, examSessionId!, stored);
    }
  }

  touchExamSession(examSessionId!);
  return {
    results,
    serverTime: now.toISOString(),
    remainingSeconds: remainingSeconds(now, new Date(meta.expiresAt)),
  };
}

async function saveBuffered(attemptId: string, meta: AttemptMeta, examSessionId: string, stored: StoredAnswer[]) {
  let out = await bufferAnswers(attemptId, meta.expiresAt, examSessionId, stored);
  if (!out.ok && (out.reason === 'META_MISSING' || out.reason === 'WRONG_SESSION')) {
    // Cache missing or stale: rebuild from Postgres (authoritative) and retry once.
    meta = await refreshAttemptMeta(attemptId);
    assertWritable(meta);
    assertExamSession(meta, examSessionId);
    out = await bufferAnswers(attemptId, meta.expiresAt, examSessionId, stored);
  }
  if (!out.ok) {
    // State changed between our check and the atomic write; report the authoritative reason.
    if (out.reason === 'EXPIRED') {
      scheduleFinalize(attemptId);
      throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
    }
    const fresh = await refreshAttemptMetaBestEffort(attemptId);
    assertWritable(fresh);
    assertExamSession(fresh, examSessionId);
    throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt is not in progress.');
  }
  return out.items.map((r, i) => ({ questionId: stored[i]!.questionId, ...r }));
}

/**
 * Write-through to Postgres (Redis unavailable, or ANSWER_BUFFER=direct). The SQL itself enforces
 * IN_PROGRESS and the deadline; per-item status comes from the rows actually written.
 */
async function saveDirect(attemptId: string, examSessionId: string, stored: StoredAnswer[]): Promise<SaveResult[]> {
  const session = await prisma.examSession.findFirst({ where: { id: examSessionId, attemptId, status: 'ACTIVE' } });
  if (!session) throw new AppError('EXAM_SESSION_SUPERSEDED', 'This exam was opened in another window or device.');

  const written = await persistAnswers(attemptId, stored, {
    deadlineGraceSeconds: env.SUBMIT_GRACE_SECONDS,
    allowSubmitting: false,
  });
  const writtenIds = new Set(written.map((w) => w.questionId));
  const current =
    writtenIds.size === stored.length
      ? new Map<string, number>()
      : new Map((await loadPersistedAnswers(attemptId)).map((a) => [a.questionId, a.revision]));

  const results: SaveResult[] = [];
  for (const s of stored) {
    if (writtenIds.has(s.questionId)) {
      results.push({ questionId: s.questionId, status: 'accepted', serverRevision: s.revision });
      continue;
    }
    const cur = current.get(s.questionId);
    if (cur === undefined || cur < s.revision) {
      // Nothing was written although this revision is newer: the attempt is no longer writable.
      const attempt = await prisma.attempt.findUniqueOrThrow({ where: { id: attemptId }, select: { status: true, expiresAt: true } });
      if (attempt.status === 'IN_PROGRESS' && !withinDeadline(new Date(), attempt.expiresAt, env.SUBMIT_GRACE_SECONDS)) {
        scheduleFinalize(attemptId);
        throw new AppError('ATTEMPT_EXPIRED', 'This exam attempt has expired.');
      }
      assertWritable({ attemptId, status: attempt.status, expiresAt: attempt.expiresAt.getTime() });
      throw new AppError('ATTEMPT_NOT_IN_PROGRESS', 'This attempt is not in progress.');
    }
    results.push({ questionId: s.questionId, status: cur === s.revision ? 'duplicate' : 'stale', serverRevision: cur });
  }
  return results;
}

/**
 * Current answers = highest revision across Postgres and the Redis buffer.
 * `complete` is false when the buffer could not be read (Redis down in buffered mode): the list may
 * then miss newer, already-acknowledged answers, and clients must not treat it as authoritative
 * (keep their local copy; do not lower local revisions to match it).
 */
export async function currentAnswers(attemptId: string): Promise<{ answers: StoredAnswer[]; complete: boolean }> {
  const persistedP = loadPersistedAnswers(attemptId);
  let buffered: StoredAnswer[] = [];
  let complete = true;
  if (env.ANSWER_BUFFER === 'redis') {
    try {
      buffered = await readBufferedAnswers(attemptId);
    } catch {
      complete = false;
    }
  }
  const byQ = new Map<string, StoredAnswer>();
  for (const a of [...(await persistedP), ...buffered]) {
    const cur = byQ.get(a.questionId);
    if (!cur || a.revision > cur.revision) byQ.set(a.questionId, a);
  }
  return { answers: [...byQ.values()], complete };
}
