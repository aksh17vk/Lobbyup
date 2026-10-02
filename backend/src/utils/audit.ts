import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db/prisma.js';

export function audit(
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata?: Prisma.InputJsonValue,
  db: Tx | typeof prisma = prisma,
) {
  return db.auditLog.create({ data: { actorId, action, entityType, entityId, metadata } });
}
