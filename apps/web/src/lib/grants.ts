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
  /**
   * `true` when the seat carries one or more same-scope DuplicateGrants
   * that were folded into this view's `building_names`. Drives the
   * "Duplicate" badge on the collapsed row. Always `false` on a raw
   * (uncollapsed) `grantsForDisplay` view; only set by
   * `collapseSameScopeGrants` and `pickGrantForScope`.
   */
  hasSameScopeDuplicates: boolean;
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
    hasSameScopeDuplicates: false,
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
      hasSameScopeDuplicates: false,
    };
  });
  return [primary, ...dupes];
}

/**
 * Stable union of building names — order preserved (`first` then any
 * names in `rest` that weren't already present). Used by the same-scope
 * collapse so the union renders in a deterministic order that matches
 * "what was already there first."
 */
function unionBuildingNames(
  first: readonly string[],
  rest: readonly (readonly string[])[],
): readonly string[] {
  const seen = new Set<string>(first);
  const out = [...first];
  for (const names of rest) {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Collapse same-scope grants on a single seat into one view per scope.
 *
 * A seat may carry a primary grant plus zero-or-more DuplicateGrants
 * with the same `scope` as the primary (e.g. an importer-driven auto
 * primary plus a manager-added manual DuplicateGrant naming additional
 * buildings). Rendering each as its own row confuses operators — the
 * primary already covers the user's access, and the duplicates are
 * additive metadata. This helper folds them into a single row whose
 * `building_names` is the union of every same-scope grant's buildings
 * and whose `hasSameScopeDuplicates` flag drives the "Duplicate" badge.
 *
 * Cross-scope grants (a DuplicateGrant whose scope differs from the
 * primary's) keep their own rows — rendering them collapsed onto a
 * different scope's row would be wrong (the duplicate's scope is what
 * earns its row on a roster). The collapse rule applies only WITHIN a
 * single scope.
 *
 * Order: the chosen view per scope is the first grant in the input
 * sequence at that scope (so the primary wins if it matches, else the
 * first duplicate at that scope). Subsequent same-scope duplicates
 * contribute their `building_names` to the union but are not emitted
 * as standalone views. Scope-emission order mirrors input order (so
 * AllSeats keeps its existing sort behaviour).
 */
export function collapseSameScopeGrants(views: readonly GrantView[]): GrantView[] {
  const byScope = new Map<string, { view: GrantView; extras: GrantView[] }>();
  const order: string[] = [];
  for (const v of views) {
    const existing = byScope.get(v.scope);
    if (existing) {
      existing.extras.push(v);
    } else {
      byScope.set(v.scope, { view: v, extras: [] });
      order.push(v.scope);
    }
  }
  return order.map((scope) => {
    const { view, extras } = byScope.get(scope)!;
    if (extras.length === 0) return view;
    const building_names = unionBuildingNames(
      view.building_names,
      extras.map((e) => e.building_names),
    );
    return { ...view, building_names, hasSameScopeDuplicates: true };
  });
}

/**
 * Resolve the `organization_id` for a rendered grant view. The primary
 * grant carries the org on the seat top level; a duplicate grant carries
 * it on its `duplicate_grants[]` entry (addressed by `duplicateIndex`).
 *
 * Returns `null` ("No Organization") when the field is unset, absent, or
 * the duplicate index doesn't resolve (defensive — a collapsed view
 * whose chosen grant was a duplicate still maps to a real entry).
 *
 * Org ids are meaningful only on stake-scope grants; callers gate this
 * to the stake roster. For any other scope the value is informational.
 */
export function resolveGrantOrgId(seat: Seat, grant: GrantView): string | null {
  if (grant.isPrimary) return seat.organization_id ?? null;
  const dup = seat.duplicate_grants?.[grant.duplicateIndex];
  return dup?.organization_id ?? null;
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
  // Otherwise prefer home-site (`kindoo_site_id === null`), else the
  // lowest-`kindoo_site_id` for stability.
  const primary = matches.find((g) => g.isPrimary);
  const chosen =
    primary ??
    matches.find((g) => g.kindoo_site_id === null) ??
    [...matches].sort((a, b) => (a.kindoo_site_id ?? '').localeCompare(b.kindoo_site_id ?? ''))[0]!;
  // Same-scope collapse: union the building_names from every other
  // same-scope grant on the seat into the chosen view. Roster pages
  // show one row per (member, scope); a same-scope DuplicateGrant adds
  // buildings to that row rather than rendering a duplicate row that
  // doesn't exist on roster surfaces.
  const others = matches.filter((g) => g !== chosen);
  if (others.length === 0) return chosen;
  return {
    ...chosen,
    building_names: unionBuildingNames(
      chosen.building_names,
      others.map((g) => g.building_names),
    ),
    hasSameScopeDuplicates: true,
  };
}
