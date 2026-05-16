// `accessRequestSchema` mirrors `types/request.ts`. This is the
// schema TanStack Router's `validateSearch` and the Cloud Function
// callable both validate against, so the shape stays defensible at
// every input boundary.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const requestTypeSchema = z.enum([
  'add_manual',
  'add_temp',
  'remove',
  'edit_auto',
  'edit_manual',
  'edit_temp',
]);
export const requestStatusSchema = z.enum(['pending', 'complete', 'rejected', 'cancelled']);

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const EDIT_REQUEST_TYPES = new Set(['edit_auto', 'edit_manual', 'edit_temp']);

export const accessRequestSchema = z
  .object({
    request_id: z.string(),
    type: requestTypeSchema,
    scope: z.string(),

    member_email: z.string(),
    member_canonical: z.string(),
    member_name: z.string(),

    reason: z.string(),
    // Optional at the wire boundary so `add_*` / `remove` writes that
    // omit the field round-trip cleanly. Edit types require a non-empty
    // trimmed comment via the `superRefine` below.
    comment: z.string().optional(),
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

    // Extension v2.2 — Provision & Complete metadata. Both optional;
    // present only when the extension's provision flow set them.
    kindoo_uid: z.string().optional(),
    provisioning_note: z.string().optional(),

    seat_member_canonical: z.string().optional(),

    lastActor: actorRefSchema,
  })
  // Edit-type requests require a non-empty trimmed `comment` so the
  // queue surfaces the operator's rationale. Add / remove unaffected:
  // their existing comment behavior (optional / empty allowed at the
  // wire boundary; cross-ward-add comment requirement lives in form
  // validation) is preserved.
  .superRefine((data, ctx) => {
    if (EDIT_REQUEST_TYPES.has(data.type)) {
      const trimmed = (data.comment ?? '').trim();
      if (trimmed.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['comment'],
          message: 'Edit requests require a non-empty comment',
        });
      }
    }
  });
