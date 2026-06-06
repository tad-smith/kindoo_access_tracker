// Unit tests for the `assertSeatSiteStamped` write-time invariant in
// `lib/wardSites.ts`. Pure (no emulator) — exercises every fire / no-fire
// branch of the guard that closes the foreign-site-seat-persisted-as-home
// class of bug.

import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { Building, Ward } from '@kindoo/shared';
import { assertSeatSiteStamped } from '../src/lib/wardSites.js';

function ward(opts: { ward_code: string; building_name: string }): Ward {
  return {
    ward_code: opts.ward_code,
    ward_name: `${opts.ward_code} Ward`,
    building_name: opts.building_name,
    seat_cap: 0,
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin', canonical: 'admin' },
  } as unknown as Ward;
}

function building(opts: { building_name: string; kindoo_site_id?: string | null }): Building {
  const b: Record<string, unknown> = {
    building_id: opts.building_name.toLowerCase().replace(/\s+/g, '-'),
    building_name: opts.building_name,
    address: '123 Test St',
    created_at: Timestamp.now(),
    last_modified_at: Timestamp.now(),
    lastActor: { email: 'admin', canonical: 'admin' },
  };
  if (opts.kindoo_site_id !== undefined) b.kindoo_site_id = opts.kindoo_site_id;
  return b as unknown as Building;
}

const FOREIGN_WARD = ward({ ward_code: 'MR', building_name: 'Black Forest' });
const FOREIGN_BUILDING = building({ building_name: 'Black Forest', kindoo_site_id: 'east-stake' });
const HOME_WARD = ward({ ward_code: 'CO', building_name: 'Maple Building' });
const HOME_BUILDING = building({ building_name: 'Maple Building', kindoo_site_id: null });

describe('assertSeatSiteStamped', () => {
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
