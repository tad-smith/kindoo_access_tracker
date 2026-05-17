// Pure helpers for expanding a Seat into the per-grant rows that
// Phase B's AllSeats multi-row rendering + roster broadened-inclusion
// surfaces consume (spec.md §15 Phase B).
//
// A `Seat` carries one primary grant at top level plus zero-or-more
// `duplicate_grants[]` entries that record additional grants of two
// kinds, distinguished by `kindoo_site_id`:
//
//   - Within-site priority loser — same site as the primary;
//     informational; covered by the primary's Kindoo write.
//   - Parallel-site grant — different site than the primary; needs
//     its own Kindoo write per the Phase A orchestrator.
//
// `grantsForDisplay(seat)` returns one `GrantView` per grant — primary
// first, then each duplicate in array order. Consumers render a
// uniform shape regardless of where the grant came from.

import type { Seat } from '@kindoo/shared';

export interface GrantView {
  /** `'stake'` or a ward_code. */
  scope: string;
  type: Seat['type'];
  /** Empty array for manual / temp. */
  callings: readonly string[];
  /** Buildings recorded against this specific grant. */
  building_names: readonly string[];
  /** `null` (home) or a foreign Kindoo site id. */
  kindoo_site_id: string | null;
  /** Free-text reason for manual / temp grants. */
  reason?: string;
  /** ISO date `YYYY-MM-DD` — temp grants only. */
  start_date?: string;
  /** ISO date `YYYY-MM-DD` — temp grants only. */
  end_date?: string;
  /** `true` for the seat's primary grant; `false` for duplicates. */
  isPrimary: boolean;
  /**
   * `true` when this grant's `kindoo_site_id` differs from the seat's
   * primary `kindoo_site_id`. Phase A's distinguishing test for
   * within-site priority losers vs parallel-site grants.
   *
   * Always `false` on the primary (a primary is its own reference).
   * On legacy / pre-migration seats where both sides are `undefined`,
   * resolves to `false` (graceful no-op — see spec §15 Phase B
   * prerequisite).
   */
  isParallelSite: boolean;
  /**
   * The `duplicate_grants[]` index for duplicate rows (`>= 0`); `-1`
   * for the primary. Used as the Remove discriminator when the
   * duplicate has no `(scope, kindoo_site_id)` tuple unique enough to
   * disambiguate by — KS-9 was resolved to use `(scope, kindoo_site_id)`
   * alone, so this is primarily a stable React key for the multi-row
   * render.
   */
  duplicateIndex: number;
}

/**
 * Normalise `kindoo_site_id` for equality comparisons. Legacy seats
 * may have the field absent (`undefined`) or empty-string; treat both
 * as home (`null`).
 */
function normalise(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

/**
 * Expand a seat into one `GrantView` per grant. The primary comes
 * first; each `duplicate_grants[]` entry follows in array order.
 *
 * Building names: a duplicate's `building_names` may be unset
 * (within-site priority losers inherit from the primary's ward — see
 * `DuplicateGrant.building_names` semantics). When unset, fall back
 * to the primary's `building_names` so the row renders something
 * useful rather than an empty buildings chip.
 */
export function grantsForDisplay(seat: Seat): GrantView[] {
  const primarySite = normalise(seat.kindoo_site_id);
  const primary: GrantView = {
    scope: seat.scope,
    type: seat.type,
    callings: seat.callings,
    building_names: seat.building_names,
    kindoo_site_id: primarySite,
    ...(seat.reason !== undefined ? { reason: seat.reason } : {}),
    ...(seat.start_date !== undefined ? { start_date: seat.start_date } : {}),
    ...(seat.end_date !== undefined ? { end_date: seat.end_date } : {}),
    isPrimary: true,
    isParallelSite: false,
    duplicateIndex: -1,
  };
  const dupes = (seat.duplicate_grants ?? []).map((d, i): GrantView => {
    const site = normalise(d.kindoo_site_id);
    return {
      scope: d.scope,
      type: d.type,
      callings: d.callings ?? [],
      building_names: d.building_names ?? seat.building_names,
      kindoo_site_id: site,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
      ...(d.start_date !== undefined ? { start_date: d.start_date } : {}),
      ...(d.end_date !== undefined ? { end_date: d.end_date } : {}),
      isPrimary: false,
      isParallelSite: site !== primarySite,
      duplicateIndex: i,
    };
  });
  return [primary, ...dupes];
}

/**
 * Pick the single `GrantView` that matches a roster page's scope —
 * primary if it matches, else the first duplicate whose scope matches.
 * Returns `null` when no grant matches (the caller filters the seat
 * out of the roster page).
 *
 * Used by per-scope roster pages (Bishopric Roster, Stake Roster,
 * Ward Rosters) for the broadened-inclusion render: one row per
 * person, columns reflect the matching grant.
 */
export function pickGrantForScope(seat: Seat, scope: string): GrantView | null {
  const views = grantsForDisplay(seat);
  return views.find((g) => g.scope === scope) ?? null;
}
