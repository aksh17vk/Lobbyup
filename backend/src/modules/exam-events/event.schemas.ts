import { z } from 'zod';
import { EVENT_TYPES } from './signals.js';

const Metadata = z
  .record(z.string().max(64), z.unknown())
  .refine((m) => JSON.stringify(m).length <= 1024, { message: 'metadata must be at most 1 KB' });

export const EventItem = z
  .object({
    clientEventId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'clientEventId may only contain letters, digits and _ . : -')
      .refine((s) => !s.startsWith('server:'), 'clientEventId prefix "server:" is reserved'),
    type: z.enum(EVENT_TYPES as [string, ...string[]]),
    timestamp: z.iso.datetime({ offset: true }).optional(),
    metadata: Metadata.optional(),
  })
  .strict();

export const EventsBody = z.object({ events: z.array(EventItem).min(1).max(100) }).strict();
export type EventItemT = z.output<typeof EventItem>;
