import type { Ward } from './types/ward.js';
import type { Building } from './types/building.js';

// Resolve a ward's Kindoo site from the building it's assigned to.
// null = home site. Unknown building → null (home).
export function resolveWardSite(
  ward: Pick<Ward, 'building_name'>,
  buildingsByName: ReadonlyMap<string, Pick<Building, 'kindoo_site_id'>>,
): string | null {
  const b = buildingsByName.get(ward.building_name);
  return b?.kindoo_site_id ?? null;
}
