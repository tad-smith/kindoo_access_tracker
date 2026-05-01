// `accessRequestSchema` mirrors `types/request.ts`. This is the
// schema TanStack Router's `validateSearch` (Phase 4+) and the
// Cloud Function callable (Phase 8+) both validate against, so the
// shape stays defensible at every input boundary.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const requestTypeSchema = z.enum(['add_manual', 'add_temp', 'remove']);
export const requestStatusSchema = z.enum(['pending', 'complete', 'rejected', 'cancelled']);

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const accessRequestSchema = z.object({
  request_id: z.string(),
  type: requestTypeSchema,
  scope: z.string(),

  member_email: z.string(),
  member_canonical: z.string(),
  member_name: z.string(),

  reason: z.string(),
  comment: z.string(),
  start_date: isoDateSchema.optional(),
  end_date: isoDateSchema.optional(),
  building_names: z.array(z.string()),

  urgent: z.boolean().optional(),

  status: requestStatusSchema,

  requester_email: z.string(),
  requester_canonical: z.string(),
  requested_at: timestampLikeSchema,

  completer_email: z.string().optional(),
  completer_canonical: z.string().optional(),
  completed_at: timestampLikeSchema.optional(),
  rejection_reason: z.string().optional(),
  completion_note: z.string().optional(),

  seat_member_canonical: z.string().optional(),

  lastActor: actorRefSchema,
});
