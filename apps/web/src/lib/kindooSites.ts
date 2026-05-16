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
