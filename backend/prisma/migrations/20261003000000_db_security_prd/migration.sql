-- AlterTable
ALTER TABLE "users" ADD COLUMN     "student_id" TEXT;

-- AlterTable
ALTER TABLE "quizzes" ADD COLUMN     "passing_marks" DECIMAL(8,2),
ADD COLUMN     "total_marks" DECIMAL(8,2);

-- AlterTable
ALTER TABLE "attempts" ADD COLUMN     "score" DECIMAL(8,2);

-- CreateIndex
CREATE UNIQUE INDEX "users_student_id_key" ON "users"("student_id");

-- CreateIndex
CREATE INDEX "answers_question_id_idx" ON "answers"("question_id");

-- CreateIndex
CREATE INDEX "exam_events_type_idx" ON "exam_events"("type");


-- ───────────── Hand-written constraints & backfill ─────────────
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_marks_nonnegative"
  CHECK (("passing_marks" IS NULL OR "passing_marks" >= 0) AND ("total_marks" IS NULL OR "total_marks" >= 0));
ALTER TABLE "users" ADD CONSTRAINT "users_student_id_not_blank"
  CHECK ("student_id" IS NULL OR length(btrim("student_id")) > 0);

-- Mirror existing results onto their attempts.
UPDATE "attempts" a SET "score" = r."score" FROM "results" r WHERE r."attempt_id" = a."id" AND a."score" IS NULL;
