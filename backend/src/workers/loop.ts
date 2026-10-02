import { logger } from '../utils/logger.js';

export interface Loop {
  stop(): Promise<void>;
}

/** Runs `tick` every `intervalMs`, never overlapping itself, and stops cleanly. */
export function startLoop(name: string, intervalMs: number, tick: () => Promise<void>): Loop {
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
    timer.unref();
  };
  const run = () => {
    running = tick()
      .catch((err) => logger.error({ err, worker: name }, 'worker tick failed'))
      .finally(() => {
        running = null;
        schedule();
      });
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}
