// Zod schemas for the New Kindoo Request form. The shape mirrors the
// rules' submit predicate in `firestore.rules`:
//
//   - `add_manual` / `add_temp`: member_name is required.
//   - `add_temp`: start_date + end_date both ISO YYYY-MM-DD; end ≥ start.
//   - stake-scope add types: at least one building selected.
//
// Same schema fuels both the client form and (where `notifyOnRequestWrite`
// or future callable validation needs it) the server side.

import { z } from 'zod';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Field-level schema. The cross-field gates ("end after start", "stake
 * needs ≥1 building", "member_name required for add types") run in
 * `superRefine` so the resolver surfaces them on the right input.
 */
export const newRequestSchema = z
  .object({
    type: z.enum(['add_manual', 'add_temp']),
    scope: z.string().min(1, 'Scope is required.'),
    member_email: z
      .string()
      .trim()
      .min(1, 'Member email is required.')
      .email('Must be a valid email.'),
    member_name: z.string().trim().min(1, 'Member name is required.'),
    reason: z.string().trim().min(1, 'Reason is required.'),
    comment: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    building_names: z.array(z.string()),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'add_temp') {
      if (!isoDateRegex.test(val.start_date)) {
        ctx.addIssue({
          code: 'custom',
          path: ['start_date'],
          message: 'Start date is required (YYYY-MM-DD).',
        });
      }
      if (!isoDateRegex.test(val.end_date)) {
        ctx.addIssue({
          code: 'custom',
          path: ['end_date'],
          message: 'End date is required (YYYY-MM-DD).',
        });
      }
      // Both ISO YYYY-MM-DD → lexical compare matches calendar order.
      if (
        isoDateRegex.test(val.start_date) &&
        isoDateRegex.test(val.end_date) &&
        val.end_date < val.start_date
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['end_date'],
          message: 'End date must be on or after the start date.',
        });
      }
    }
    if (val.scope === 'stake' && val.building_names.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['building_names'],
        message: 'Pick at least one building for a stake-scope request.',
      });
    }
  });

export type NewRequestForm = z.infer<typeof newRequestSchema>;

/**
 * Removal-modal schema. The X / trashcan path collects only the
 * `reason` text; everything else (scope, member, type='remove') is
 * carried from the seat row. The rules accept an empty member_name for
 * `remove`, so we don't gate on that here.
 */
export const removeRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to submit a removal.'),
});

export type RemoveRequestForm = z.infer<typeof removeRequestSchema>;

/**
 * Reject-dialog schema. Required reason is enforced both client-side
 * (this schema) and server-side (rules require non-empty
 * `rejection_reason`).
 */
export const rejectRequestSchema = z.object({
  rejection_reason: z.string().trim().min(1, 'A rejection reason is required.'),
});

export type RejectRequestForm = z.infer<typeof rejectRequestSchema>;

/**
 * Mark-Complete dialog schema for `add_manual` / `add_temp`. At least
 * one building must be ticked; remove-completion has no buildings.
 */
export const completeAddRequestSchema = z.object({
  building_names: z.array(z.string()).min(1, 'Pick at least one building.'),
});

export type CompleteAddRequestForm = z.infer<typeof completeAddRequestSchema>;
