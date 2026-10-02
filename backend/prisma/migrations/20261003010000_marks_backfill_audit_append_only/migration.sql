-- 1. Backfill total_marks for quizzes published before the column existed.
--    Total = unpooled points + draw_count × the pool's (uniform) points. Quizzes with a pool that
--    mixes marks stay NULL (they could not be published under the current rules either).
UPDATE "quizzes" q
   SET "total_marks" = t.total
  FROM (
    SELECT qz."id",
           COALESCE((SELECT SUM(x."points") FROM "questions" x WHERE x."quiz_id" = qz."id" AND x."pool_id" IS NULL), 0)
         + COALESCE((SELECT SUM(p."draw_count" * (SELECT MIN(y."points") FROM "questions" y WHERE y."pool_id" = p."id"))
                       FROM "question_pools" p WHERE p."quiz_id" = qz."id"), 0) AS total
      FROM "quizzes" qz
     WHERE qz."status" <> 'DRAFT' AND qz."total_marks" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM "questions" z JOIN "question_pools" p ON p."id" = z."pool_id"
          WHERE p."quiz_id" = qz."id"
          GROUP BY p."id"
         HAVING COUNT(DISTINCT (z."points", z."negative_points")) > 1)
  ) t
 WHERE q."id" = t."id";

-- 2. The audit trail is append-only for everyone except the table owner (defence in depth on top
--    of the app role's grants, so it holds even if grants are misconfigured).
CREATE OR REPLACE FUNCTION "audit_logs_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_logs') THEN
    RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_append_only"();

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_append_only"();
