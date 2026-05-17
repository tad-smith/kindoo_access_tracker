// Pure helpers for Kindoo-site filtering and labeling (spec.md §15).
//
//   - `siteIdForScope(scope, wards)` — resolves a submission scope (a
//     ward_code or `'stake'`) to the Kindoo site id that scope targets.
//     Stake-scope resolves to `null` (home only — per spec §15 Phase 2,
//     stake-scope is intentionally restricted to home-site buildings).
//     Ward-scope resolves to that ward's `kindoo_site_id` (`null` /
//     absent → home). Returns `null` if the ward isn't in the catalogue
//     yet (live subscription not hydrated).
//   - `filterBuildingsBySite(buildings, siteId)` — keeps only buildings
//     whose `kindoo_site_id` matches. Legacy buildings without the field
//     are treated as home (`null`).
//   - `siteLabelForSeat(seat, wards, sites)` — returns the foreign
//     KindooSite's `display_name` to render as a small badge on ward-
//     scope seats, or `null` for home-site / stake-scope / when the
//     catalogues haven't loaded.

import type { Building, KindooSite, Seat, Ward } from '@kindoo/shared';

/**
 * Normalise a ward's / building's `kindoo_site_id`. Legacy docs may
 * have the field absent; treat that as home (`null`). Empty-string is
 * not a valid id from the Configuration UI but we coerce it for
 * defensiveness.
 */
function normaliseSiteId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

/**
 * Resolve a submission scope to the Kindoo site id it targets. Stake-
 * scope is locked to home (`null`) per spec §15 (Phase 2). Ward-scope
 * resolves through the wards catalogue. Returns `null` (home) when the
 * ward isn't in the catalogue — the form's empty-state will tell the
 * user no buildings are available.
 */
export function siteIdForScope(scope: string, wards: readonly Ward[]): string | null {
  if (!scope) return null;
  if (scope === 'stake') return null;
  const ward = wards.find((w) => w.ward_code === scope);
  if (!ward) return null;
  return normaliseSiteId(ward.kindoo_site_id);
}

/**
 * Filter the buildings catalogue down to one Kindoo site. `null`
 * (home) keeps home-site buildings; a string keeps buildings whose
 * `kindoo_site_id` matches. Legacy buildings without the field are
 * treated as home.
 */
export function filterBuildingsBySite(
  buildings: readonly Building[],
  siteId: string | null,
): Building[] {
  return buildings.filter((b) => normaliseSiteId(b.kindoo_site_id) === siteId);
}

/**
 * Foreign-site label to render next to a ward-scope seat. Returns the
 * `KindooSite.display_name` when the seat's scope is a ward bound to a
 * foreign site; `null` otherwise (stake-scope, home-site wards,
 * unknown wards, or sites collection not yet hydrated).
 */
export function siteLabelForSeat(
  seat: Pick<Seat, 'scope'>,
  wards: readonly Ward[],
  sites: readonly KindooSite[],
): string | null {
  if (!seat.scope || seat.scope === 'stake') return null;
  const ward = wards.find((w) => w.ward_code === seat.scope);
  if (!ward) return null;
  const siteId = normaliseSiteId(ward.kindoo_site_id);
  if (!siteId) return null;
  const site = sites.find((s) => s.id === siteId);
  if (!site) return null;
  return site.display_name;
}

/**
 * Foreign-site label for a single grant view (Phase B). Resolves the
 * grant's own `kindoo_site_id` (already populated by the per-grant
 * view layer) against the sites catalogue, falling back to the
 * ward-lookup path on un-migrated legacy data (where the grant's
 * `kindoo_site_id` is null).
 *
 * Stake-scope grants resolve to home (`null`) per Phase 1 policy.
 * T-43.
 */
export function siteLabelForGrant(
  grant: { scope: string; kindoo_site_id: string | null },
  wards: readonly Ward[],
  sites: readonly KindooSite[],
): string | null {
  if (!grant.scope || grant.scope === 'stake') return null;
  if (grant.kindoo_site_id) {
    const site = sites.find((s) => s.id === grant.kindoo_site_id);
    return site ? site.display_name : null;
  }
  // Legacy / un-migrated fallback: resolve through the ward.
  const ward = wards.find((w) => w.ward_code === grant.scope);
  if (!ward) return null;
  const wardSiteId = normaliseSiteId(ward.kindoo_site_id);
  if (!wardSiteId) return null;
  const site = sites.find((s) => s.id === wardSiteId);
  return site ? site.display_name : null;
}

/**
 * Resolve a seat's Kindoo site id. T-42: reads `Seat.kindoo_site_id`
 * directly when populated (the importer + `markRequestComplete` stamp
 * it; the migration backfills it on legacy seats); falls back to
 * resolving the seat's `scope` through the wards catalogue when the
 * field is absent (legacy / pre-migration data still in flight).
 * Returns `null` for home; a string id for foreign.
 *
 * Externally-visible behaviour matches the pre-T-42 wards-only path —
 * the field is just a denormalisation. Centralised here so every
 * caller (utilization filters, roster badges, stake-pool exclusion)
 * reads the same fallback chain.
 */
export function seatSiteId(
  seat: Pick<Seat, 'scope' | 'kindoo_site_id'>,
  wards: readonly Ward[],
): string | null {
  // Explicit value (including explicit `null` for home) wins — the
  // seat doc carries the canonical answer once the importer / merge
  // has run. Empty string is coerced to null defensively.
  if (seat.kindoo_site_id !== undefined) {
    return normaliseSiteId(seat.kindoo_site_id);
  }
  // Field absent: fall back to the ward-lookup path so legacy seats
  // (pre-migration) still resolve correctly.
  return siteIdForScope(seat.scope, wards);
}
