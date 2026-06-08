// Zod schemas for the New Kindoo Request form. The shape mirrors the
// rules' submit predicate in `firestore.rules`:
//
//   - `add_manual` / `add_temp`: member_name is required.
//   - `add_temp`: start_date + end_date both ISO YYYY-MM-DD; end ≥ start.
//   - add types (every scope): at least one building selected.
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
import { resolveWardBuilding } from '@kindoo/shared';
import type { Building, Ward } from '@kindoo/shared';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The default-selected building set for a single submission scope.
 * Stake-scope defaults to every building in the passed catalogue —
 * stake-scope means "everywhere," so the manager unchecks specific
 * buildings to exclude rather than ticking N every time (B-11). Ward-
 * scope resolves the ward's building id-first (`resolveWardBuilding`)
 * and returns its current display name; empty when the ward isn't in
 * the catalogue or has no building bound.
 *
 * Grant arrays stay display-name strings, so this returns the building's
 * `building_name` (resolved from the immutable `building_id` when set,
 * else the ward's legacy name snapshot).
 *
 * The form passes its *visible* (site-filtered) catalogue so stake-
 * scope picks only home buildings (spec §15). The cross-ward predicate
 * passes the full catalogue so it can id-resolve the ward's building.
 * The form additionally clamps the ward-scope default via
 * `clampWardDefaultsToVisible` so a ward whose building is hidden by the
 * site filter (legacy mid-migration state) does not pre-check an
 * invisible building.
 */
export function defaultBuildingsForScope(
  scope: string,
  wards: readonly Ward[],
  buildings: readonly Building[] = [],
): string[] {
  if (!scope) return [];
  if (scope === 'stake') return buildings.map((b) => b.building_name);
  const ward = wards.find((w) => w.ward_code === scope);
  if (!ward) return [];
  // Id-first: resolve the ward's building and use its current display
  // name. Fall back to the ward's own `building_name` snapshot when the
  // catalogue can't resolve it (e.g. catalogue not hydrated yet) so the
  // pre-check still works mid-load.
  const resolved = resolveWardBuilding(ward, buildings);
  const name = resolved?.building_name ?? ward.building_name;
  return name ? [name] : [];
}

/**
 * Clamp a ward-scope default set to the visible (site-filtered)
 * catalogue. Stake-scope passes through unchanged — the stake-scope
 * default already comes from the visible catalogue inside
 * `defaultBuildingsForScope`. For ward scope, drop any default whose
 * building name has no matching entry in the visible set so the form
 * cannot pre-check a building the user cannot see (and therefore
 * cannot uncheck). Legacy data where `ward.building_name` disagrees
 * with `ward.kindoo_site_id` collapses to an empty pre-check; the
 * user can then expand the panel and pick from whatever the site
 * filter shows.
 */
export function clampWardDefaultsToVisible(
  scope: string,
  defaults: readonly string[],
  visibleBuildings: readonly Building[],
): string[] {
  if (scope === 'stake' || !scope) return [...defaults];
  const visibleNames = new Set(visibleBuildings.map((b) => b.building_name));
  return defaults.filter((n) => visibleNames.has(n));
}

/**
 * Cross-ward predicate. `true` when the submission's scope is a ward
 * AND at least one selected building is NOT in that ward's default
 * set. Stake scope (and any combination of `building_names` inside the
 * default set) returns `false`. The comment-required gate fires on
 * `true`. The buildings catalogue is threaded so the ward's default
 * building resolves id-first (`resolveWardBuilding`); pass `[]` only
 * where id resolution isn't needed (the ward's legacy name snapshot is
 * then used as the default).
 */
export function isCrossWardSelection(
  scope: string,
  buildingNames: readonly string[],
  wards: readonly Ward[],
  buildings: readonly Building[] = [],
): boolean {
  if (!scope || scope === 'stake') return false;
  const defaults = defaultBuildingsForScope(scope, wards, buildings);
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
    // Optional org selector — meaningful only at stake scope. The slug
    // id of the chosen organization, or null = "No Organization". The
    // submit hook drops it for ward scope (see useSubmitRequest).
    organization_id: z.string().nullable().optional(),
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
    if (val.building_names.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['building_names'],
        message:
          val.scope === 'stake'
            ? 'Pick at least one building for a stake-scope request.'
            : 'Pick at least one building.',
      });
    }
    if (val.urgent && val.comment.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'A comment is required when the request is marked as an emergency.',
      });
    }
  });

export type NewRequestForm = z.infer<typeof newRequestSchema>;

/**
 * Schema factory that closes over the wards + buildings catalogues so
 * the cross-ward-comment-required gate can resolve a ward code to its
 * default building (id-first). The form constructs the schema in a
 * `useMemo` keyed on the wards + buildings subscriptions. Server-side
 * validation should keep using `newRequestSchema` directly — the
 * cross-ward rule is a UX nudge, not a defense-in-depth gate.
 */
export function makeNewRequestSchema(wards: readonly Ward[], buildings: readonly Building[] = []) {
  return newRequestSchema.superRefine((val, ctx) => {
    if (val.urgent) return; // urgent path already requires a comment.
    if (!isCrossWardSelection(val.scope, val.building_names, wards, buildings)) return;
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
 * Edit-seat modal schema. One flat shape that fans into three request
 * types via the `type` discriminator. Per-type required-field gates
 * fire in the `superRefine`:
 *
 *   - `edit_auto`: building_names ≥ 1 + non-empty trimmed comment.
 *   - `edit_manual`: reason non-empty + building_names ≥ 1 + non-empty
 *     trimmed comment.
 *   - `edit_temp`: reason non-empty + building_names ≥ 1 + ISO
 *     start_date + ISO end_date + end_date >= start_date + non-empty
 *     trimmed comment.
 *
 * The comment gate matches the shared `accessRequestSchema` and the
 * Firestore rules' edit-request predicate (defense in depth, see
 * spec.md §6.1).
 *
 * The dialog uses `useForm<EditSeatForm>({ values: initial })` so
 * opening for a different seat re-seeds the fields. Submission threads
 * the validated payload into `useSubmitRequest`.
 */
export const editSeatSchema = z
  .object({
    type: z.enum(['edit_auto', 'edit_manual', 'edit_temp']),
    reason: z.string(),
    comment: z.string(),
    building_names: z.array(z.string()),
    start_date: z.string(),
    end_date: z.string(),
    // Optional org selector — meaningful only at stake scope, and only
    // for edit_manual / edit_temp (edit_auto is forbidden at stake, so
    // the selector is never rendered there). Slug id or null = "No
    // Organization".
    organization_id: z.string().nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type !== 'edit_auto' && val.reason.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: val.type === 'edit_temp' ? 'Reason is required.' : 'Calling is required.',
      });
    }
    if (val.comment.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'A comment is required for edit requests.',
      });
    }
    if (val.building_names.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['building_names'],
        message: 'Pick at least one building.',
      });
    }
    if (val.type === 'edit_temp') {
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
  });

export type EditSeatForm = z.infer<typeof editSeatSchema>;

/**
 * "Give Access To Stake Buildings" modal schema — the manager-only
 * affordance on All Seats that grants a foreign-site-only member a
 * stake-scope seat (home-site buildings). Scope is locked to `'stake'`
 * by the dialog, so it carries no scope field. Reason is a required
 * free-text Input (the calling typeahead is intentionally NOT used —
 * a stake building grant isn't calling-derived). Comment is optional.
 * At least one building must be selected. Submits as `add_manual` /
 * `scope: 'stake'` through the existing submit path.
 */
export const grantStakeAccessSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required.'),
  comment: z.string(),
  building_names: z.array(z.string()).min(1, 'Pick at least one building.'),
});

export type GrantStakeAccessForm = z.infer<typeof grantStakeAccessSchema>;
