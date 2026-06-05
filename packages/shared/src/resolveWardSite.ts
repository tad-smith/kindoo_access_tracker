import type { Ward } from './types/ward.js';
import type { Building } from './types/building.js';

// Building resolution for wards. Wards reference a building by the
// immutable `building_id` slug (preferred) and keep a legacy
// `building_name` display-name FK populated during the additive
// transition. Resolution is id-first with a name fallback so both new
// (slug-bearing) and legacy (name-only) ward docs resolve.

/**
 * Resolve the `Building` a ward is assigned to. **Id-first:** when
 * `ward.building_id` is set, match `building.building_id` first. On an
 * id miss — and whenever `building_id` is absent — fall back to matching
 * `building.building_name`. Returns `undefined` only when BOTH paths
 * miss (unknown / orphaned reference).
 *
 * `building_id` is the immutable slug — once written it never drifts,
 * so an id match survives a building's display-name being edited. The
 * name fallback covers legacy wards that predate the slug FK (and stale
 * bundles mid-migration).
 *
 * The id-miss → name fallback is INTENTIONAL, not a bug: a ward whose
 * slug points at a building that no longer exists (deleted, or a slug
 * from an un-migrated/stale bundle) still resolves when its
 * `building_name` snapshot matches a live building. This keeps
 * mid-migration data legible at the cost of a soft rebind if a name
 * happens to collide — acceptable while the additive transition keeps
 * `building_name` populated. `undefined` is returned only when neither
 * the slug nor the name resolves.
 */
export function resolveWardBuilding(
  ward: Pick<Ward, 'building_id' | 'building_name'>,
  buildings: readonly Building[],
): Building | undefined {
  if (ward.building_id) {
    const byId = buildings.find((b) => b.building_id === ward.building_id);
    if (byId) return byId;
    // Fall through to the name path: a stale slug (e.g. the building was
    // deleted and re-created under a new name) still resolves by name
    // when one matches. This keeps mid-migration data legible.
  }
  if (ward.building_name) {
    return buildings.find((b) => b.building_name === ward.building_name);
  }
  return undefined;
}

// Resolve a ward's Kindoo site from the building it's assigned to.
// null = home site. Unknown building → null (home). Id-first via
// `resolveWardBuilding`.
export function resolveWardSite(
  ward: Pick<Ward, 'building_id' | 'building_name'>,
  buildings: readonly Building[],
): string | null {
  return resolveWardBuilding(ward, buildings)?.kindoo_site_id ?? null;
}

/**
 * Look up a building's current display name by its immutable slug.
 * Returns `undefined` when no building carries that `building_id`.
 * Used to render a slug FK as a human-readable name without threading
 * the whole `Building` through. Null / undefined / empty `buildingId`
 * resolves to `undefined`.
 */
export function buildingNameById(
  buildings: readonly Building[],
  buildingId: string | null | undefined,
): string | undefined {
  if (!buildingId) return undefined;
  return buildings.find((b) => b.building_id === buildingId)?.building_name;
}
