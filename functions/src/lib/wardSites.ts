// Ward → Kindoo-site resolution. A ward no longer stores `kindoo_site_id`;
// its site is derived from the building it's assigned to (the building
// carries the `kindoo_site_id`, `null`/absent = home). These helpers
// build the lookup maps consumers need from the wards + buildings
// collections.

import type { Building, Ward } from '@kindoo/shared';
import { resolveWardSite } from '@kindoo/shared';

/** `building_name → { kindoo_site_id }` for `resolveWardSite`. Absent
 * `kindoo_site_id` is normalised to `null` (home). */
export function buildingsByName(
  buildings: Building[],
): Map<string, Pick<Building, 'kindoo_site_id'>> {
  const map = new Map<string, Pick<Building, 'kindoo_site_id'>>();
  for (const b of buildings) {
    map.set(b.building_name, { kindoo_site_id: b.kindoo_site_id ?? null });
  }
  return map;
}

/**
 * `ward_code → kindoo_site_id` (`null` = home) for every ward, resolved
 * through its assigned building. Wards whose building is unknown resolve
 * to home (`null`), matching `resolveWardSite`.
 */
export function wardSiteMap(wards: Ward[], buildings: Building[]): Map<string, string | null> {
  const byName = buildingsByName(buildings);
  const map = new Map<string, string | null>();
  for (const w of wards) {
    map.set(w.ward_code, resolveWardSite(w, byName));
  }
  return map;
}
