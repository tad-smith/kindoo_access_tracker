import { describe, expect, it } from 'vitest';
import { resolveWardSite } from './resolveWardSite.js';
import type { Building } from './types/building.js';

function buildingsMap(
  entries: Array<[string, Pick<Building, 'kindoo_site_id'>]>,
): ReadonlyMap<string, Pick<Building, 'kindoo_site_id'>> {
  return new Map(entries);
}

describe('resolveWardSite', () => {
  it('returns the foreign site of the ward’s building', () => {
    const map = buildingsMap([['Pine Building', { kindoo_site_id: 'east-stake' }]]);
    expect(resolveWardSite({ building_name: 'Pine Building' }, map)).toBe('east-stake');
  });

  it('returns null when the building is on the home site', () => {
    const map = buildingsMap([['Maple Building', { kindoo_site_id: null }]]);
    expect(resolveWardSite({ building_name: 'Maple Building' }, map)).toBeNull();
  });

  it('returns null when the building has no kindoo_site_id (absent → home)', () => {
    const map = buildingsMap([['Maple Building', {}]]);
    expect(resolveWardSite({ building_name: 'Maple Building' }, map)).toBeNull();
  });

  it('returns null when the building is unknown (missing → home)', () => {
    const map = buildingsMap([['Maple Building', { kindoo_site_id: 'east-stake' }]]);
    expect(resolveWardSite({ building_name: 'Nonexistent' }, map)).toBeNull();
  });
});
