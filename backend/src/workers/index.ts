import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { drainAnswerBuffer, startAnswerFlushWorker } from './answer-flush.worker.js';
import { startExpiryWorker } from './expiry.worker.js';
import type { Loop } from './loop.js';

export function startWorkers(): Loop[] {
  logger.info('starting background workers');
  return [startAnswerFlushWorker(env.ANSWER_FLUSH_INTERVAL_MS), startExpiryWorker(env.EXPIRY_SWEEP_INTERVAL_MS)];
}

export async function stopWorkers(loops: Loop[]) {
  await Promise.all(loops.map((l) => l.stop()));
  await drainAnswerBuffer().catch((err) => logger.error({ err }, 'final answer drain failed'));
}
