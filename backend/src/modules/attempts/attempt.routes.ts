import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requirePermission } from '../../middleware/authorize.js';
import { limits } from '../../middleware/rate-limit.js';
import { ok } from '../../utils/response.js';
import { parse } from '../../utils/validate.js';
import { AttemptParams, AttemptQuestionParams, SaveAnswerBody, SubmitBody, SyncBody } from '../answers/answer.schemas.js';
import { saveAnswers } from '../answers/answer.service.js';
import { EventsBody } from '../exam-events/event.schemas.js';
import { recordClientEvents } from '../exam-events/event.service.js';
import { requireAuthContext } from '../permissions/authorize.js';
import { clientInfo, getAttempt, resumeAttempt, startAttempt, submitAttempt, syncAttempt } from './attempt.service.js';

const DeviceInfo = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
  .refine((d) => Object.keys(d).length <= 20, 'deviceInfo may have at most 20 keys')
  .optional();

const StartBody = z.object({ quizId: z.uuid(), deviceInfo: DeviceInfo }).strict();
const ResumeBody = z.object({ deviceInfo: DeviceInfo }).strict();

/** The exam session id travels in a header so it applies uniformly to every write. */
const examSessionHeader = (req: FastifyRequest) => {
  const v = req.headers['x-exam-session-id'];
  const id = Array.isArray(v) ? v[0] : v;
  return id && z.uuid().safeParse(id).success ? id : undefined;
};

export async function attemptRoutes(app: FastifyInstance) {
  app.post('/attempts', { preHandler: [requirePermission('START_EXAM'), limits.attemptStart] }, async (req, reply) => {
    const auth = requireAuthContext(req.auth);
    const body = parse(StartBody, req.body);
    const out = await startAttempt(auth, body.quizId, clientInfo(req, body.deviceInfo as Prisma.InputJsonValue));
    return ok(reply, { ...out.view, examSessionId: out.examSessionId, resumed: !out.created, tookOver: out.tookOver }, out.created ? 201 : 200);
  });

  app.get('/attempts/:attemptId', { preHandler: [limits.global] }, async (req, reply) => {
    const auth = requireAuthContext(req.auth);
    const { attemptId } = parse(AttemptParams, req.params, 'params');
    return ok(reply, await getAttempt(auth, attemptId));
  });

  app.post(
    '/attempts/:attemptId/resume',
    { preHandler: [requirePermission('START_EXAM'), limits.attemptStart] },
    async (req, reply) => {
      const auth = requireAuthContext(req.auth);
      const { attemptId } = parse(AttemptParams, req.params, 'params');
      const body = parse(ResumeBody, req.body);
      const out = await resumeAttempt(auth, attemptId, clientInfo(req, body.deviceInfo as Prisma.InputJsonValue));
      return ok(reply, { ...out.view, examSessionId: out.examSessionId, tookOver: out.tookOver });
    },
  );

  app.put(
    '/attempts/:attemptId/answers/:questionId',
    { preHandler: [requirePermission('SAVE_ANSWER'), limits.answer] },
    async (req, reply) => {
      const auth = requireAuthContext(req.auth);
      const { attemptId, questionId } = parse(AttemptQuestionParams, req.params, 'params');
      const body = parse(SaveAnswerBody, req.body);
      const out = await saveAnswers(auth, attemptId, examSessionHeader(req), [{ questionId, ...body }]);
      return ok(reply, { ...out.results[0], serverTime: out.serverTime, remainingSeconds: out.remainingSeconds });
    },
  );

  app.post(
    '/attempts/:attemptId/sync',
    { preHandler: [requirePermission('SAVE_ANSWER'), limits.sync] },
    async (req, reply) => {
      const auth = requireAuthContext(req.auth);
      const { attemptId } = parse(AttemptParams, req.params, 'params');
      const body = parse(SyncBody, req.body);
      return ok(reply, await syncAttempt(auth, attemptId, examSessionHeader(req), body.answers));
    },
  );

  app.post(
    '/attempts/:attemptId/submit',
    { preHandler: [requirePermission('SUBMIT_EXAM'), limits.submit] },
    async (req, reply) => {
      const auth = requireAuthContext(req.auth);
      const { attemptId } = parse(AttemptParams, req.params, 'params');
      const body = parse(SubmitBody, req.body);
      return ok(reply, await submitAttempt(auth, attemptId, examSessionHeader(req), body.answers));
    },
  );

  app.post(
    '/attempts/:attemptId/events',
    { preHandler: [requirePermission('START_EXAM'), limits.events] },
    async (req, reply) => {
      const auth = requireAuthContext(req.auth);
      const { attemptId } = parse(AttemptParams, req.params, 'params');
      const body = parse(EventsBody, req.body);
      return ok(reply, await recordClientEvents(auth, attemptId, examSessionHeader(req), body.events), 202);
    },
  );
}
