import type { FastifyReply } from 'fastify';

export function ok<T>(reply: FastifyReply, data: T, statusCode = 200) {
  return reply.status(statusCode).send({ success: true, data });
}

export interface Page {
  page: number;
  pageSize: number;
}

export function paged<T>(items: T[], total: number, p: Page) {
  return {
    items,
    pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) },
  };
}
