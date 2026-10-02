import type { FastifyInstance } from 'fastify';
import { requireAnyPermission } from '../../middleware/authorize.js';
import { limits } from '../../middleware/rate-limit.js';
import { ok } from '../../utils/response.js';
import { parse } from '../../utils/validate.js';
import { AttemptParams } from '../answers/answer.schemas.js';
import { requireAuthContext } from '../permissions/authorize.js';
import { getResult } from './result.service.js';

export async function resultRoutes(app: FastifyInstance) {
  app.get(
    '/results/:attemptId',
    { preHandler: [requireAnyPermission('VIEW_OWN_RESULT', 'VIEW_ALL_RESULTS'), limits.global] },
    async (req, reply) => {
      const { attemptId } = parse(AttemptParams, req.params, 'params');
      return ok(reply, await getResult(requireAuthContext(req.auth), attemptId));
    },
  );
}
