import type { FastifyRequest } from 'fastify';
import { assertPermission, hasAnyPermission, requireAuthContext } from '../modules/permissions/authorize.js';
import type { Permission } from '../modules/permissions/catalog.js';
import { forbidden } from '../utils/errors.js';

export const requireAuth = async (req: FastifyRequest) => {
  requireAuthContext(req.auth);
};

/** Requires ALL listed permissions. */
export const requirePermission =
  (...perms: Permission[]) =>
  async (req: FastifyRequest) => {
    assertPermission(req.auth, ...perms);
  };

/** Requires AT LEAST ONE of the listed permissions. */
export const requireAnyPermission =
  (...perms: Permission[]) =>
  async (req: FastifyRequest) => {
    requireAuthContext(req.auth);
    if (!hasAnyPermission(req.auth, perms)) throw forbidden();
  };
