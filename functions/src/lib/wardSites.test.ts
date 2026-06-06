import { describe, expect, it } from 'vitest';
import type { Building, Ward } from '@kindoo/shared';
import { assertSeatSiteStamped, wardSiteMap } from './wardSites.js';

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

describe('assertSeatSiteStamped', () => {
  const FOREIGN_WARD = ward({ ward_code: 'MR', building_name: 'Black Forest' });
  const FOREIGN_BUILDING = building({
    building_id: 'black-forest',
    building_name: 'Black Forest',
    kindoo_site_id: 'east-stake',
  });
  const HOME_WARD = ward({ ward_code: 'CO', building_name: 'Maple Building' });
  const HOME_BUILDING = building({
    building_id: 'maple-building',
    building_name: 'Maple Building',
    kindoo_site_id: null,
  });

  it('throws when a known foreign-site ward seat has kindoo_site_id absent', () => {
    expect(() =>
      assertSeatSiteStamped({
        scope: 'MR',
        body: {},
        wards: [FOREIGN_WARD],
        buildings: [FOREIGN_BUILDING],
        context: 'test',
      }),
    ).toThrowError(/foreign-site ward 'MR'/);
  });

  it('throws when a known foreign-site ward seat has kindoo_site_id null', () => {
    expect(() =>
      assertSeatSiteStamped({
        scope: 'MR',
        body: { kindoo_site_id: null },
        wards: [FOREIGN_WARD],
        buildings: [FOREIGN_BUILDING],
        context: 'test',
      }),
    ).toThrowError(/foreign-site ward 'MR'/);
  });

  it('throws for a non-auto (manual/temp-shaped) foreign-ward seat written field-absent', () => {
    // The guard is type-agnostic — it keys off scope + resolved site, not
    // seat type. This documents that a manual/temp kindoo-only seat (the
    // extension's default) hitting the guard field-absent fails loudly,
    // closing the bug for every type, not just auto.
    expect(() =>
      assertSeatSiteStamped({
        scope: 'MR',
        body: { callings: [], reason: 'sub clerk', type: 'manual' } as never,
        wards: [FOREIGN_WARD],
        buildings: [FOREIGN_BUILDING],
        context: 'test',
      }),
    ).toThrowError(/foreign-site ward 'MR'/);
  });

  it('does NOT throw when a foreign-site ward seat carries its site', () => {
    expect(() =>
      assertSeatSiteStamped({
        scope: 'MR',
        body: { kindoo_site_id: 'east-stake' },
        wards: [FOREIGN_WARD],
        buildings: [FOREIGN_BUILDING],
        context: 'test',
      }),
    ).not.toThrow();
  });

  it('does NOT throw for a home-ward seat with the field absent', () => {
    expect(() =>
      assertSeatSiteStamped({
        scope: 'CO',
        body: {},
        wards: [HOME_WARD],
        buildings: [HOME_BUILDING],
        context: 'test',
      }),
    ).not.toThrow();
  });

  it('does NOT throw for a stake-scope seat with the field absent', () => {
    expect(() =>
      assertSeatSiteStamped({
        scope: 'stake',
        body: {},
        wards: [FOREIGN_WARD],
        buildings: [FOREIGN_BUILDING],
        context: 'test',
      }),
    ).not.toThrow();
  });

  it('does NOT throw for an unknown/missing ward (read-time fallback classifies)', () => {
    expect(() =>
      assertSeatSiteStamped({
        scope: 'ZZ',
        body: {},
        wards: [FOREIGN_WARD, HOME_WARD],
        buildings: [FOREIGN_BUILDING, HOME_BUILDING],
        context: 'test',
      }),
    ).not.toThrow();
  });

  it('throws an HttpsError with code internal', () => {
    let caught: unknown;
    try {
      assertSeatSiteStamped({
        scope: 'MR',
        body: {},
        wards: [FOREIGN_WARD],
        buildings: [FOREIGN_BUILDING],
        context: 'test',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'internal' });
  });
});
