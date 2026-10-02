import { prisma, type Tx } from '../../db/prisma.js';
import type { AnswerResponseT } from './answer.schemas.js';

export interface StoredAnswer {
  questionId: string;
  revision: number;
  response: AnswerResponseT;
  clientSavedAt: string | null;
  serverSavedAt: string;
  /** Exam session that wrote this value (buffered answers only). */
  examSessionId?: string | null;
}

/**
 * Idempotent batch upsert into Postgres. Returns the rows actually inserted or updated.
 *
 *  - UNIQUE(attempt_id, question_id) → repeated requests never create duplicates.
 *  - `WHERE answers.revision < EXCLUDED.revision` → stale/out-of-order writes are ignored.
 *  - The attempt row is read FOR SHARE and must be IN_PROGRESS/SUBMITTING, so nothing can be
 *    written once submission has locked and finalised the attempt.
 *  - The composite FK to attempt_questions guarantees the question belongs to this attempt.
 *
 * `deadlineGraceSeconds` (when set) additionally enforces the server-side timer in SQL; used
 * when answers are written directly (Redis unavailable or ANSWER_BUFFER=direct).
 */
export async function persistAnswers(
  attemptId: string,
  items: StoredAnswer[],
  opts: { deadlineGraceSeconds?: number; allowSubmitting?: boolean } = {},
  db: Tx | typeof prisma = prisma,
): Promise<{ questionId: string; revision: number }[]> {
  if (items.length === 0) return [];
  const enforce = opts.deadlineGraceSeconds !== undefined;
  const grace = opts.deadlineGraceSeconds ?? 0;
  // The background flush must still drain into SUBMITTING attempts; direct client writes must not.
  const allowSubmitting = opts.allowSubmitting ?? true;

  const rows = await db.$queryRaw<{ question_id: string; revision: bigint }[]>`
    INSERT INTO answers (id, attempt_id, question_id, response, revision, client_saved_at, server_saved_at)
    SELECT gen_random_uuid(), a.id, v.question_id::uuid, v.response::jsonb, v.revision,
           v.client_saved_at::timestamptz, v.server_saved_at::timestamptz
      FROM (
        SELECT id FROM attempts
         WHERE id = ${attemptId}::uuid
           AND (status = 'IN_PROGRESS'::"AttemptStatus"
                OR (${allowSubmitting}::boolean AND status = 'SUBMITTING'::"AttemptStatus"))
           AND (${enforce}::boolean IS FALSE OR now() <= expires_at + make_interval(secs => ${grace}::double precision))
         FOR SHARE
      ) a
      CROSS JOIN unnest(
        ${items.map((i) => i.questionId)}::text[],
        ${items.map((i) => JSON.stringify(i.response))}::text[],
        ${items.map((i) => String(i.revision))}::bigint[],
        ${items.map((i) => i.clientSavedAt)}::text[],
        ${items.map((i) => i.serverSavedAt)}::text[]
      ) AS v(question_id, response, revision, client_saved_at, server_saved_at)
    ON CONFLICT (attempt_id, question_id) DO UPDATE
       SET response = EXCLUDED.response,
           revision = EXCLUDED.revision,
           client_saved_at = EXCLUDED.client_saved_at,
           server_saved_at = EXCLUDED.server_saved_at
     WHERE answers.revision < EXCLUDED.revision
    RETURNING question_id::text AS question_id, revision`;
  return rows.map((r) => ({ questionId: r.question_id, revision: Number(r.revision) }));
}

export async function loadPersistedAnswers(attemptId: string, db: Tx | typeof prisma = prisma) {
  const rows = await db.answer.findMany({ where: { attemptId } });
  return rows.map((r) => ({
    questionId: r.questionId,
    revision: Number(r.revision),
    response: r.response as AnswerResponseT,
    clientSavedAt: r.clientSavedAt?.toISOString() ?? null,
    serverSavedAt: r.serverSavedAt.toISOString(),
  }));
}

/** Postgres "data exception" / check-violation errors: the row itself is unstorable. */
export function isDataError(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } };
  const pg = e?.meta?.code ?? '';
  return e?.code === 'P2010' && (pg.startsWith('22') || pg === '23514' || pg === '23503');
}
