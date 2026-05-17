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
 * Building names: a duplicate's `building_names` may be unset on a
 * within-site priority loser (it inherits from the primary's ward —
 * see `DuplicateGrant.building_names` semantics). When unset, fall
 * back to the primary's `building_names` so the row renders something
 * useful rather than an empty buildings chip.
 *
 * T-43 follow-up: the fallback applies ONLY to same-site duplicates.
 * For a parallel-site duplicate (different `kindoo_site_id`), the
 * primary's `building_names` are on a different Kindoo site, so
 * rendering them on the foreign-site row would surface wrong data
 * (home-site buildings on a foreign-site grant). Phase A's per-site
 * provisioner stamps `building_names` on every parallel-site
 * duplicate it writes, so this fallback should rarely trigger in
 * healthy state; the empty-list result is the correct graceful-
 * degradation shape for legacy / pre-migration seats.
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
    const isParallelSite = site !== primarySite;
    // T-43 follow-up: only inherit from the primary on same-site
    // duplicates. Parallel-site duplicates rendering home-site
    // buildings would be wrong data; an empty list is the correct
    // graceful-degradation shape.
    const fallbackBuildings = isParallelSite ? [] : seat.building_names;
    return {
      scope: d.scope,
      type: d.type,
      callings: d.callings ?? [],
      building_names: d.building_names ?? fallbackBuildings,
      kindoo_site_id: site,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
      ...(d.start_date !== undefined ? { start_date: d.start_date } : {}),
      ...(d.end_date !== undefined ? { end_date: d.end_date } : {}),
      isPrimary: false,
      isParallelSite,
      duplicateIndex: i,
    };
  });
  return [primary, ...dupes];
}

/**
 * Pick the single `GrantView` that matches a roster page's scope.
 * Used by per-scope roster pages (Bishopric Roster, Stake Roster,
 * Ward Rosters) for the broadened-inclusion render: one row per
 * person, columns reflect the matching grant.
 *
 * A person can legitimately hold multiple grants at the same scope —
 * a stake-primary plus two CO duplicates (one home-site, one
 * foreign-site) all coexist after Phase A multi-site grants. The
 * roster surface renders only one row per person, so we need a
 * deterministic pick:
 *
 *   1. Primary if its scope matches (always wins — it's the row's
 *      home record).
 *   2. Else home-site duplicate (`kindoo_site_id === null`) — the
 *      grant tied to this stake's own Kindoo site, which is the most
 *      meaningful for a roster page on this stake.
 *   3. Else the lowest-`kindoo_site_id` foreign-site duplicate (stable
 *      lexicographic order). Ties are vanishingly rare at single-stake
 *      scale; lowest-id is just a tie-breaker so two re-renders return
 *      the same grant.
 *
 * Returns `null` when no grant matches (the caller filters the seat
 * out of the roster page).
 */
export function pickGrantForScope(seat: Seat, scope: string): GrantView | null {
  const matches = grantsForDisplay(seat).filter((g) => g.scope === scope);
  if (matches.length === 0) return null;
  // Primary always wins (it's a row's home record by definition).
  const primary = matches.find((g) => g.isPrimary);
  if (primary) return primary;
  // Among duplicates: prefer home-site (`kindoo_site_id === null`),
  // else lowest-`kindoo_site_id` for stability.
  const homeSite = matches.find((g) => g.kindoo_site_id === null);
  if (homeSite) return homeSite;
  return [...matches].sort((a, b) =>
    (a.kindoo_site_id ?? '').localeCompare(b.kindoo_site_id ?? ''),
  )[0]!;
}
