/**
 * Post-load-test integrity check against Postgres (the source of truth).
 *   pnpm exec tsx --env-file=.env loadtest/verify-loadtest.ts <expectedDistinctAnswers> <expectedSubmitted>
 * The two numbers come from the k6 summary counters lobbyup_distinct_answers_saved and
 * lobbyup_attempts_submitted.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')) as { quizId: string };
const [expectedAnswers, expectedSubmitted] = process.argv.slice(2).map(Number);

try {
  const quizId = fixture.quizId;
  const [attempts, byStatus, answers, results, dupResults, dupAnswers, liveExamSessions] = await Promise.all([
    prisma.attempt.count({ where: { quizId } }),
    prisma.attempt.groupBy({ by: ['status'], where: { quizId }, _count: { _all: true } }),
    prisma.answer.count({ where: { attempt: { quizId } } }),
    prisma.result.count({ where: { quizId } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT attempt_id FROM results GROUP BY attempt_id HAVING count(*) > 1) d`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT attempt_id, question_id FROM answers GROUP BY 1, 2 HAVING count(*) > 1) d`,
    prisma.examSession.count({ where: { attempt: { quizId }, status: 'ACTIVE' } }),
  ]);
  const dupAttempts = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM (SELECT user_id FROM attempts WHERE quiz_id = ${quizId}::uuid GROUP BY user_id HAVING count(*) > 1) d`;

  const report = {
    attempts,
    attemptsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    answersInPostgres: answers,
    expectedDistinctAnswers: expectedAnswers ?? null,
    results,
    expectedSubmitted: expectedSubmitted ?? null,
    duplicateResults: Number(dupResults[0]!.n),
    duplicateAnswers: Number(dupAnswers[0]!.n),
    studentsWithMultipleAttempts: Number(dupAttempts[0]!.n),
    activeExamSessionsLeft: liveExamSessions,
  };
  console.log(JSON.stringify(report, null, 2));

  const problems: string[] = [];
  if (expectedAnswers !== undefined && answers !== expectedAnswers) problems.push(`answers ${answers} ≠ expected ${expectedAnswers} (LOST OR EXTRA ANSWERS)`);
  if (expectedSubmitted !== undefined && results !== expectedSubmitted) problems.push(`results ${results} ≠ submitted ${expectedSubmitted}`);
  if (report.duplicateResults) problems.push('duplicate results found');
  if (report.duplicateAnswers) problems.push('duplicate answers found');
  if (report.studentsWithMultipleAttempts) problems.push('students with more than one attempt');
  console.log(problems.length ? `✘ ${problems.join('; ')}` : '✔ integrity OK: no lost answers, no duplicate answers/results/attempts');
  process.exitCode = problems.length ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
