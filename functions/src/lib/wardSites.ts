// Ward → Kindoo-site resolution. A ward no longer stores `kindoo_site_id`;
// its site is derived from the building it's assigned to (the building
// carries the `kindoo_site_id`, `null`/absent = home). Resolution is
// id-first (ward's `building_id` slug) with a `building_name` fallback
// for legacy/un-migrated wards — see `resolveWardSite` in `@kindoo/shared`.

import type { Building, Ward } from '@kindoo/shared';
import { resolveWardSite } from '@kindoo/shared';

/**
 * `ward_code → kindoo_site_id` (`null` = home) for every ward, resolved
 * through its assigned building. Wards whose building is unknown resolve
 * to home (`null`), matching `resolveWardSite`.
 */
export function wardSiteMap(wards: Ward[], buildings: Building[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const w of wards) {
    map.set(w.ward_code, resolveWardSite(w, buildings));
  }
  return map;
}
