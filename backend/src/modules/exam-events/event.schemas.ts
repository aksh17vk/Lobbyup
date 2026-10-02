import { z } from 'zod';
import { EVENT_TYPES } from './signals.js';

/**
 * Data minimisation: metadata is a small flat map of scalars (e.g. { durationMs: 1200, key: "c" }).
 * Nested objects and long strings are rejected so clients cannot ship pasted content, page
 * snapshots or other personal data with proctoring events.
 */
const Metadata = z
  .record(
    z.string().regex(/^[A-Za-z0-9_]{1,40}$/, 'metadata keys must be short identifiers'),
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((m) => Object.keys(m).length <= 12, { message: 'metadata may have at most 12 keys' })
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
