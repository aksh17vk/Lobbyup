import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/authorize.js';
import { limits } from '../../middleware/rate-limit.js';
import { ok } from '../../utils/response.js';
import { parse } from '../../utils/validate.js';
import { requireAuthContext } from '../permissions/authorize.js';
import { QuizIdParams } from './quiz.schemas.js';
import { getQuizForStudent, listQuizzesForStudent } from './quiz.service.js';

/** Student-facing quiz catalogue. Never includes questions or answers. */
export async function quizRoutes(app: FastifyInstance) {
  app.get('/quizzes', { preHandler: [requireAuth, limits.global] }, async (req, reply) => {
    return ok(reply, await listQuizzesForStudent(requireAuthContext(req.auth).userId));
  });

  app.get('/quizzes/:quizId', { preHandler: [requireAuth, limits.global] }, async (req, reply) => {
    const { quizId } = parse(QuizIdParams, req.params, 'params');
    return ok(reply, await getQuizForStudent(quizId, requireAuthContext(req.auth).userId));
  });
}
