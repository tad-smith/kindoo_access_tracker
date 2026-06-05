import { describe, expect, it } from 'vitest';
import type { Building, Ward } from '@kindoo/shared';
import { wardSiteMap } from './wardSites.js';

const ACTOR = { email: 'a@gmail.com', canonical: 'a@gmail.com' };
const TS = { seconds: 0, nanoseconds: 0 } as unknown as Building['created_at'];

function building(
  opts: Partial<Building> & Pick<Building, 'building_id' | 'building_name'>,
): Building {
  return {
    address: '123 Test St',
    created_at: TS,
    last_modified_at: TS,
    lastActor: ACTOR,
    ...opts,
  };
}

function ward(opts: Partial<Ward> & Pick<Ward, 'ward_code' | 'building_name'>): Ward {
  return {
    ward_name: `${opts.ward_code} Ward`,
    seat_cap: 0,
    created_at: TS,
    last_modified_at: TS,
    lastActor: ACTOR,
    ...opts,
  };
}

describe('wardSiteMap', () => {
  it('resolves id-first: ward.building_id wins over a name collision', () => {
    const buildings = [
      // Same display name, different slugs + sites. The id-bearing ward
      // must bind to the slug, not the first name match.
      building({
        building_id: 'maple-east',
        building_name: 'Maple Building',
        kindoo_site_id: 'east-stake',
      }),
      building({
        building_id: 'maple-home',
        building_name: 'Maple Building',
        kindoo_site_id: null,
      }),
    ];
    const wards = [
      ward({ ward_code: 'CO', building_id: 'maple-east', building_name: 'Maple Building' }),
    ];
    expect(wardSiteMap(wards, buildings).get('CO')).toBe('east-stake');
  });

  it('falls back to building_name for legacy wards with no building_id', () => {
    const buildings = [
      building({
        building_id: 'pine',
        building_name: 'Pine Building',
        kindoo_site_id: 'west-stake',
      }),
    ];
    const wards = [ward({ ward_code: 'FN', building_name: 'Pine Building' })];
    expect(wardSiteMap(wards, buildings).get('FN')).toBe('west-stake');
  });

  it('a stale building_id slug falls back to a matching name', () => {
    const buildings = [
      building({
        building_id: 'oak',
        building_name: 'Oak Building',
        kindoo_site_id: 'south-stake',
      }),
    ];
    // building_id points at a slug that no longer exists; name still matches.
    const wards = [
      ward({ ward_code: 'OK', building_id: 'oak-deleted', building_name: 'Oak Building' }),
    ];
    expect(wardSiteMap(wards, buildings).get('OK')).toBe('south-stake');
  });

  it('resolves to home (null) when neither id nor name matches a building', () => {
    const buildings = [
      building({
        building_id: 'oak',
        building_name: 'Oak Building',
        kindoo_site_id: 'south-stake',
      }),
    ];
    const wards = [
      ward({ ward_code: 'ZZ', building_id: 'gone', building_name: 'Nonexistent Building' }),
    ];
    expect(wardSiteMap(wards, buildings).get('ZZ')).toBeNull();
  });
});
