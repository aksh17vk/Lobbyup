import type { FastifyInstance } from 'fastify';
import { requireAnyPermission, requireAuth, requirePermission } from '../../middleware/authorize.js';
import { limits } from '../../middleware/rate-limit.js';
import { PageQuery } from '../../utils/pagination.js';
import { ok, paged } from '../../utils/response.js';
import { parse } from '../../utils/validate.js';
import { AttemptParams } from '../answers/answer.schemas.js';
import { requireAuthContext } from '../permissions/authorize.js';
import { CreateQuestionsBody, QuestionIdParams, QuestionInput } from '../questions/question.schemas.js';
import {
  createPool,
  createQuestions,
  deletePool,
  deleteQuestion,
  replaceQuestion,
  updatePool,
} from '../questions/question.service.js';
import type { QuizAction } from '../quizzes/quiz.lifecycle.js';
import { AdminQuizListQuery, CreateQuizBody, PoolBody, PoolIdParams, QuizIdParams, UpdateQuizBody } from '../quizzes/quiz.schemas.js';
import {
  createQuiz,
  deleteQuiz,
  getQuizAdmin,
  listQuizzesAdmin,
  transitionQuiz,
  updateQuiz,
} from '../quizzes/quiz.service.js';
import { listPermissions, listRoles, RoleIdParams, SetPermissionsBody, setRolePermissions } from '../roles/role.service.js';
import {
  CreateUsersBody,
  createUsers,
  listUsers,
  ResetPasswordBody,
  resetPassword,
  revokeUserSessions,
  SetRolesBody,
  setUserRoles,
  UpdateUserBody,
  updateUser,
  UserIdParams,
  UserListQuery,
} from '../users/user.service.js';
import {
  AdminAttemptQuery,
  AdminResultQuery,
  CancelBody,
  cancelAttempt,
  getAttemptDetail,
  listAttemptEvents,
  listAttempts,
  listResults,
  listViolations,
  ReviewBody,
  reviewViolation,
  systemStatus,
  ViolationQuery,
} from './admin.service.js';

/**
 * Everything under /admin requires authentication; each route additionally declares the
 * exact permission it needs, and services enforce resource ownership (e.g. quiz owner).
 */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', limits.admin);

  // ───────────── Quizzes ─────────────
  app.post('/quizzes', { preHandler: requirePermission('CREATE_EXAM') }, async (req, reply) => {
    const body = parse(CreateQuizBody, req.body);
    return ok(reply, await createQuiz(requireAuthContext(req.auth), body), 201);
  });

  app.get(
    '/quizzes',
    { preHandler: requireAnyPermission('EDIT_EXAM', 'MANAGE_QUESTIONS', 'VIEW_ATTEMPTS', 'VIEW_ALL_RESULTS') },
    async (req, reply) => {
      const q = parse(AdminQuizListQuery, req.query, 'query');
      const { items, total } = await listQuizzesAdmin(requireAuthContext(req.auth), q);
      return ok(reply, paged(items, total, q));
    },
  );

  app.get('/quizzes/:quizId', { preHandler: requireAnyPermission('EDIT_EXAM', 'MANAGE_QUESTIONS') }, async (req, reply) => {
    const { quizId } = parse(QuizIdParams, req.params, 'params');
    return ok(reply, await getQuizAdmin(requireAuthContext(req.auth), quizId));
  });

  app.put('/quizzes/:quizId', { preHandler: requirePermission('EDIT_EXAM') }, async (req, reply) => {
    const { quizId } = parse(QuizIdParams, req.params, 'params');
    const body = parse(UpdateQuizBody, req.body);
    return ok(reply, await updateQuiz(requireAuthContext(req.auth), quizId, body));
  });

  app.delete('/quizzes/:quizId', { preHandler: requirePermission('DELETE_EXAM') }, async (req, reply) => {
    const { quizId } = parse(QuizIdParams, req.params, 'params');
    await deleteQuiz(requireAuthContext(req.auth), quizId);
    return ok(reply, { deleted: true });
  });

  for (const action of ['publish', 'unpublish', 'activate', 'end', 'archive'] as QuizAction[]) {
    app.post(`/quizzes/:quizId/${action}`, { preHandler: requirePermission('PUBLISH_EXAM') }, async (req, reply) => {
      const { quizId } = parse(QuizIdParams, req.params, 'params');
      return ok(reply, await transitionQuiz(requireAuthContext(req.auth), quizId, action));
    });
  }

  // ───────────── Questions & pools ─────────────
  app.post('/quizzes/:quizId/questions', { preHandler: requirePermission('MANAGE_QUESTIONS') }, async (req, reply) => {
    const { quizId } = parse(QuizIdParams, req.params, 'params');
    const body = parse(CreateQuestionsBody, req.body);
    const inputs = 'questions' in body ? body.questions : [body];
    return ok(reply, await createQuestions(requireAuthContext(req.auth), quizId, inputs), 201);
  });

  app.put('/questions/:questionId', { preHandler: requirePermission('MANAGE_QUESTIONS') }, async (req, reply) => {
    const { questionId } = parse(QuestionIdParams, req.params, 'params');
    const body = parse(QuestionInput, req.body);
    return ok(reply, await replaceQuestion(requireAuthContext(req.auth), questionId, body));
  });

  app.delete('/questions/:questionId', { preHandler: requirePermission('MANAGE_QUESTIONS') }, async (req, reply) => {
    const { questionId } = parse(QuestionIdParams, req.params, 'params');
    await deleteQuestion(requireAuthContext(req.auth), questionId);
    return ok(reply, { deleted: true });
  });

  app.post('/quizzes/:quizId/pools', { preHandler: requirePermission('MANAGE_QUESTIONS') }, async (req, reply) => {
    const { quizId } = parse(QuizIdParams, req.params, 'params');
    return ok(reply, await createPool(requireAuthContext(req.auth), quizId, parse(PoolBody, req.body)), 201);
  });

  app.put('/pools/:poolId', { preHandler: requirePermission('MANAGE_QUESTIONS') }, async (req, reply) => {
    const { poolId } = parse(PoolIdParams, req.params, 'params');
    return ok(reply, await updatePool(requireAuthContext(req.auth), poolId, parse(PoolBody, req.body)));
  });

  app.delete('/pools/:poolId', { preHandler: requirePermission('MANAGE_QUESTIONS') }, async (req, reply) => {
    const { poolId } = parse(PoolIdParams, req.params, 'params');
    await deletePool(requireAuthContext(req.auth), poolId);
    return ok(reply, { deleted: true });
  });

  // ───────────── Attempts & violations ─────────────
  app.get('/attempts', { preHandler: requirePermission('VIEW_ATTEMPTS') }, async (req, reply) => {
    const q = parse(AdminAttemptQuery, req.query, 'query');
    const { items, total } = await listAttempts(q);
    return ok(reply, paged(items, total, q));
  });

  app.get('/attempts/:attemptId', { preHandler: requirePermission('VIEW_ATTEMPTS') }, async (req, reply) => {
    const { attemptId } = parse(AttemptParams, req.params, 'params');
    return ok(reply, await getAttemptDetail(attemptId));
  });

  app.get('/attempts/:attemptId/events', { preHandler: requirePermission('VIEW_VIOLATIONS') }, async (req, reply) => {
    const { attemptId } = parse(AttemptParams, req.params, 'params');
    const page = parse(PageQuery, req.query, 'query');
    const { items, total } = await listAttemptEvents(attemptId, page);
    return ok(reply, paged(items, total, page));
  });

  app.post('/attempts/:attemptId/cancel', { preHandler: requirePermission('EDIT_EXAM') }, async (req, reply) => {
    const { attemptId } = parse(AttemptParams, req.params, 'params');
    const body = parse(CancelBody, req.body);
    await cancelAttempt(requireAuthContext(req.auth), attemptId, body.reason);
    return ok(reply, { cancelled: true });
  });

  app.get('/violations', { preHandler: requirePermission('VIEW_VIOLATIONS') }, async (req, reply) => {
    const q = parse(ViolationQuery, req.query, 'query');
    const { items, total } = await listViolations(q);
    return ok(reply, paged(items, total, q));
  });

  app.post('/violations/:attemptId/review', { preHandler: requirePermission('REVIEW_VIOLATIONS') }, async (req, reply) => {
    const { attemptId } = parse(AttemptParams, req.params, 'params');
    const body = parse(ReviewBody, req.body);
    return ok(reply, await reviewViolation(requireAuthContext(req.auth), attemptId, body));
  });

  // ───────────── Results ─────────────
  app.get('/results', { preHandler: requirePermission('VIEW_ALL_RESULTS') }, async (req, reply) => {
    const q = parse(AdminResultQuery, req.query, 'query');
    const { items, total, stats } = await listResults(q);
    return ok(reply, { ...paged(items, total, q), stats });
  });

  // ───────────── Users & roles ─────────────
  app.get('/users', { preHandler: requirePermission('MANAGE_USERS') }, async (req, reply) => {
    const q = parse(UserListQuery, req.query, 'query');
    const { items, total } = await listUsers(q);
    return ok(reply, paged(items, total, q));
  });

  app.post('/users', { preHandler: requirePermission('MANAGE_USERS') }, async (req, reply) => {
    const body = parse(CreateUsersBody, req.body);
    const items = 'users' in body ? body.users : [body];
    return ok(reply, await createUsers(requireAuthContext(req.auth), items), 201);
  });

  app.patch('/users/:userId', { preHandler: requirePermission('MANAGE_USERS') }, async (req, reply) => {
    const { userId } = parse(UserIdParams, req.params, 'params');
    return ok(reply, await updateUser(requireAuthContext(req.auth), userId, parse(UpdateUserBody, req.body)));
  });

  app.put('/users/:userId/roles', { preHandler: requirePermission('MANAGE_ROLES') }, async (req, reply) => {
    const { userId } = parse(UserIdParams, req.params, 'params');
    const body = parse(SetRolesBody, req.body);
    return ok(reply, await setUserRoles(requireAuthContext(req.auth), userId, body.roles));
  });

  app.post('/users/:userId/reset-password', { preHandler: requirePermission('MANAGE_USERS') }, async (req, reply) => {
    const { userId } = parse(UserIdParams, req.params, 'params');
    const body = parse(ResetPasswordBody, req.body);
    await resetPassword(requireAuthContext(req.auth), userId, body.newPassword);
    return ok(reply, { reset: true });
  });

  app.post('/users/:userId/revoke-sessions', { preHandler: requirePermission('MANAGE_USERS') }, async (req, reply) => {
    const { userId } = parse(UserIdParams, req.params, 'params');
    return ok(reply, { revokedSessions: await revokeUserSessions(requireAuthContext(req.auth), userId) });
  });

  app.get('/roles', { preHandler: requirePermission('MANAGE_ROLES') }, async (_req, reply) => ok(reply, await listRoles()));

  app.get('/permissions', { preHandler: requirePermission('MANAGE_ROLES') }, async (_req, reply) => ok(reply, listPermissions()));

  app.put('/roles/:roleId/permissions', { preHandler: requirePermission('MANAGE_ROLES') }, async (req, reply) => {
    const { roleId } = parse(RoleIdParams, req.params, 'params');
    const body = parse(SetPermissionsBody, req.body);
    return ok(reply, await setRolePermissions(requireAuthContext(req.auth), roleId, body.permissions));
  });

  // ───────────── System ─────────────
  app.get('/system/status', { preHandler: requirePermission('SYSTEM_SETTINGS') }, async (_req, reply) =>
    ok(reply, await systemStatus()),
  );
}
