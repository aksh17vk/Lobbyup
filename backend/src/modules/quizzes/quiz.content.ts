import type { QuestionType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { keys, redis } from '../../db/redis.js';
import { toCents } from '../../utils/money.js';

export interface ContentOption {
  id: string;
  text: string;
  isCorrect: boolean;
  position: number;
}

export interface ContentQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  /** Hundredths of a point. */
  pointsCents: number;
  negativeCents: number;
  acceptedAnswers: string[];
  poolId: string | null;
  position: number;
  options: ContentOption[];
}

export interface QuizContent {
  quizId: string;
  version: number;
  pools: { id: string; name: string; drawCount: number }[];
  questions: ContentQuestion[];
}

/**
 * Quiz content (including correct answers) is immutable for a given contentVersion
 * (edits are only allowed in DRAFT and bump the version), so it can be cached
 * aggressively: process memory → Redis → Postgres.
 * The content object is SERVER-SIDE ONLY; never serialise it to a student.
 */
const local = new Map<string, QuizContent>();
const LOCAL_MAX = 100;
const REDIS_TTL_SECONDS = 6 * 3600;

async function loadFromDb(quizId: string): Promise<QuizContent | null> {
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: {
      pools: true,
      questions: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } },
    },
  });
  if (!quiz) return null;
  return {
    quizId: quiz.id,
    version: quiz.contentVersion,
    pools: quiz.pools.map((p) => ({ id: p.id, name: p.name, drawCount: p.drawCount })),
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      pointsCents: toCents(q.points),
      negativeCents: toCents(q.negativePoints),
      acceptedAnswers: q.acceptedAnswers,
      poolId: q.poolId,
      position: q.position,
      options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, position: o.position })),
    })),
  };
}

function remember(content: QuizContent) {
  const k = `${content.quizId}:${content.version}`;
  if (local.size >= LOCAL_MAX) local.delete(local.keys().next().value!);
  local.set(k, content);
}

export async function getQuizContent(quizId: string, version: number): Promise<QuizContent> {
  const hit = local.get(`${quizId}:${version}`);
  if (hit) return hit;

  try {
    const raw = await redis.get(keys.quizContent(quizId, version));
    if (raw) {
      const content = JSON.parse(raw) as QuizContent;
      remember(content);
      return content;
    }
  } catch {
    /* fall back to Postgres */
  }

  const content = await loadFromDb(quizId);
  if (!content) throw new Error(`quiz ${quizId} not found while loading content`);
  if (content.version === version) {
    remember(content);
    redis.set(keys.quizContent(quizId, version), JSON.stringify(content), 'EX', REDIS_TTL_SECONDS).catch(() => {});
  }
  return content;
}

/** Validates that a quiz can be published. Returns human-readable problems (empty = OK). */
export function validateForPublish(content: QuizContent): string[] {
  const problems: string[] = [];
  if (content.questions.length === 0) problems.push('Quiz has no questions.');

  for (const [i, q] of content.questions.entries()) {
    const label = `Question ${i + 1}`;
    const correct = q.options.filter((o) => o.isCorrect).length;
    if (q.type === 'SHORT_TEXT') {
      if (q.acceptedAnswers.length === 0) problems.push(`${label}: SHORT_TEXT needs at least one accepted answer.`);
    } else {
      if (q.options.length < 2) problems.push(`${label}: needs at least two options.`);
      if (q.type === 'SINGLE_CHOICE' && correct !== 1) problems.push(`${label}: SINGLE_CHOICE needs exactly one correct option.`);
      if (q.type === 'MULTIPLE_CHOICE' && correct < 1) problems.push(`${label}: MULTIPLE_CHOICE needs at least one correct option.`);
    }
  }

  for (const pool of content.pools) {
    const inPool = content.questions.filter((q) => q.poolId === pool.id);
    if (inPool.length < pool.drawCount) {
      problems.push(`Pool "${pool.name}" draws ${pool.drawCount} but only has ${inPool.length} questions.`);
    }
    // Every student must face the same total: questions drawn from one pool must be worth the same.
    const marks = new Set(inPool.map((q) => `${q.pointsCents}/${q.negativeCents}`));
    if (marks.size > 1) problems.push(`Pool "${pool.name}" mixes questions with different marks or negative marks.`);
  }
  return problems;
}

/**
 * Marks every attempt is out of: all unpooled questions plus drawCount × the (uniform) marks of
 * each pool. Computed by the server at publish time; never accepted from clients.
 */
export function totalMarksCents(content: QuizContent): number {
  let total = content.questions.filter((q) => !q.poolId).reduce((n, q) => n + q.pointsCents, 0);
  for (const pool of content.pools) {
    const first = content.questions.find((q) => q.poolId === pool.id);
    total += (first?.pointsCents ?? 0) * pool.drawCount;
  }
  return total;
}
