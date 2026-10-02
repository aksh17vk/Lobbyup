import { flushDirtyAttempts } from '../modules/answers/answer.buffer.js';
import { logger } from '../utils/logger.js';
import { startLoop, type Loop } from './loop.js';

/** Moves buffered answers from Redis into Postgres in batches (write-behind). */
export function startAnswerFlushWorker(intervalMs: number): Loop {
  return startLoop('answer-flush', intervalMs, async () => {
    // Keep draining while there is backlog, so bursts are absorbed quickly.
    for (let i = 0; i < 10; i++) {
      const { attempts, failed } = await flushDirtyAttempts(200);
      if (failed) logger.warn({ failed }, 'answer flush: some attempts failed and were re-queued');
      if (attempts < 200) break;
    }
  });
}

/** Final drain on shutdown so a deploy never strands buffered answers. */
export async function drainAnswerBuffer() {
  for (let i = 0; i < 50; i++) {
    const { attempts } = await flushDirtyAttempts(200);
    if (attempts === 0) return;
  }
}
