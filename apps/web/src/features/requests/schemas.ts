// Zod schemas for the New Kindoo Request form. The shape mirrors the
// rules' submit predicate in `firestore.rules`:
//
//   - `add_manual` / `add_temp`: member_name is required.
//   - `add_temp`: start_date + end_date both ISO YYYY-MM-DD; end ≥ start.
//   - stake-scope add types: at least one building selected.
//   - `urgent=true`: comment becomes required.
//   - ward-scope with at least one building selected outside the ward's
//     own default-building set: comment becomes required (the
//     "cross-ward" justification rule). Enforced via the
//     `makeNewRequestSchema(wards)` factory which closes over the
//     wards catalogue so the schema can map a ward code to its
//     default building. The plain `newRequestSchema` skips this gate;
//     reserve it for backend / shared-package use where the wards
//     context isn't available.
//
// Same shape fuels both the client form and (where `notifyOnRequestWrite`
// or future callable validation needs it) the server side.

import { z } from 'zod';
import type { Building, Ward } from '@kindoo/shared';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The default-selected building set for a single submission scope.
 * Stake-scope defaults to every building in the catalogue — stake-scope
 * means "everywhere," so the manager unchecks specific buildings to
 * exclude rather than ticking N every time (B-11). Ward-scope resolves
 * to the single `building_name` on the ward doc, or empty when the ward
 * isn't in the catalogue or has no building bound. The form uses this
 * to seed the buildings widget; the cross-ward predicate uses it for
 * ward scopes only (stake scope short-circuits before this is called).
 */
export function defaultBuildingsForScope(
  scope: string,
  wards: readonly Ward[],
  buildings: readonly Building[] = [],
): string[] {
  if (!scope) return [];
  if (scope === 'stake') return buildings.map((b) => b.building_name);
  const ward = wards.find((w) => w.ward_code === scope);
  if (!ward || !ward.building_name) return [];
  return [ward.building_name];
}

/**
 * Cross-ward predicate. `true` when the submission's scope is a ward
 * AND at least one selected building is NOT in that ward's default
 * set. Stake scope (and any combination of `building_names` inside the
 * default set) returns `false`. The comment-required gate fires on
 * `true`.
 */
export function isCrossWardSelection(
  scope: string,
  buildingNames: readonly string[],
  wards: readonly Ward[],
): boolean {
  if (!scope || scope === 'stake') return false;
  const defaults = defaultBuildingsForScope(scope, wards);
  return buildingNames.some((name) => !defaults.includes(name));
}

/**
 * Base object schema — every cross-field gate that does NOT require
 * the wards catalogue lives in this `superRefine`. The factory below
 * layers the cross-ward-comment-required gate on top.
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
    urgent: z.boolean(),
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
    if (val.urgent && val.comment.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'A comment is required when the request is marked urgent.',
      });
    }
  });

export type NewRequestForm = z.infer<typeof newRequestSchema>;

/**
 * Schema factory that closes over the wards catalogue so the
 * cross-ward-comment-required gate can resolve a ward code to its
 * default building. The form constructs the schema in a `useMemo`
 * keyed on the wards subscription. Server-side validation should
 * keep using `newRequestSchema` directly — the cross-ward rule is a
 * UX nudge, not a defense-in-depth gate.
 */
export function makeNewRequestSchema(wards: readonly Ward[]) {
  return newRequestSchema.superRefine((val, ctx) => {
    if (val.urgent) return; // urgent path already requires a comment.
    if (!isCrossWardSelection(val.scope, val.building_names, wards)) return;
    if (val.comment.trim().length > 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['comment'],
      message: 'Comment is required when requesting buildings outside the ward.',
    });
  });
}

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
 * `completion_note` is always optional free text — the hook trims and
 * drops it when empty before writing.
 */
export const completeAddRequestSchema = z.object({
  building_names: z.array(z.string()).min(1, 'Pick at least one building.'),
  completion_note: z.string(),
});

export type CompleteAddRequestForm = z.infer<typeof completeAddRequestSchema>;

/**
 * Mark-Complete dialog schema for `remove`. Only the optional
 * `completion_note` is collected from the manager. The R-1 race case
 * (seat already gone) is handled in the hook, not the schema.
 */
export const completeRemoveRequestSchema = z.object({
  completion_note: z.string(),
});

export type CompleteRemoveRequestForm = z.infer<typeof completeRemoveRequestSchema>;
