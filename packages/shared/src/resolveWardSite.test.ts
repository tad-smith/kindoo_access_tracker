import { describe, expect, it } from 'vitest';
import { buildingNameById, resolveWardBuilding, resolveWardSite } from './resolveWardSite.js';
import type { Building } from './types/building.js';
import type { Ward } from './types/ward.js';

// Minimal Building factory — only the fields the resolvers read. The
// bookkeeping fields are cast away since the resolvers never touch them.
function building(partial: Partial<Building> & Pick<Building, 'building_id'>): Building {
  return {
    building_name: partial.building_id,
    address: '',
    ...partial,
  } as Building;
}

function ward(partial: Pick<Ward, 'building_name'> & Partial<Pick<Ward, 'building_id'>>): Ward {
  return partial as Ward;
}

describe('resolveWardBuilding', () => {
  it('matches by building_id when present (id-first)', () => {
    const buildings = [
      building({ building_id: 'pine-building', building_name: 'Pine Building' }),
      building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    ];
    const b = resolveWardBuilding(
      { building_id: 'pine-building', building_name: 'Maple Building' },
      buildings,
    );
    // id wins over the (mismatched) name snapshot.
    expect(b?.building_id).toBe('pine-building');
  });

  it('survives a display-name edit because the slug is immutable', () => {
    // The building was renamed after the ward was written; the ward's
    // stale `building_name` no longer matches, but the immutable
    // `building_id` slug still resolves it.
    const buildings = [building({ building_id: 'pine-building', building_name: 'Oak Building' })];
    const b = resolveWardBuilding(
      { building_id: 'pine-building', building_name: 'Pine Building' },
      buildings,
    );
    expect(b?.building_id).toBe('pine-building');
    expect(b?.building_name).toBe('Oak Building');
  });

  it('falls back to building_name when building_id is absent (legacy ward)', () => {
    const buildings = [
      building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    ];
    const b = resolveWardBuilding({ building_name: 'Maple Building' }, buildings);
    expect(b?.building_id).toBe('maple-building');
  });

  it('falls back to building_name when building_id matches nothing (stale slug)', () => {
    const buildings = [
      building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    ];
    const b = resolveWardBuilding(
      { building_id: 'deleted-building', building_name: 'Maple Building' },
      buildings,
    );
    expect(b?.building_id).toBe('maple-building');
  });

  it('returns undefined when neither id nor name resolves', () => {
    const buildings = [
      building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    ];
    expect(
      resolveWardBuilding({ building_id: 'nope', building_name: 'Nonexistent' }, buildings),
    ).toBeUndefined();
    expect(resolveWardBuilding({ building_name: 'Nonexistent' }, buildings)).toBeUndefined();
  });
});

describe('resolveWardSite', () => {
  it('returns the foreign site of the ward’s building (id-first)', () => {
    const buildings = [
      building({
        building_id: 'pine-building',
        building_name: 'Pine Building',
        kindoo_site_id: 'east-stake',
      }),
    ];
    expect(
      resolveWardSite({ building_id: 'pine-building', building_name: 'Pine Building' }, buildings),
    ).toBe('east-stake');
  });

  it('returns the foreign site via the name fallback (legacy ward)', () => {
    const buildings = [
      building({
        building_id: 'pine-building',
        building_name: 'Pine Building',
        kindoo_site_id: 'east-stake',
      }),
    ];
    expect(resolveWardSite(ward({ building_name: 'Pine Building' }), buildings)).toBe('east-stake');
  });

  it('returns null when the building is on the home site', () => {
    const buildings = [
      building({
        building_id: 'maple-building',
        building_name: 'Maple Building',
        kindoo_site_id: null,
      }),
    ];
    expect(
      resolveWardSite(
        { building_id: 'maple-building', building_name: 'Maple Building' },
        buildings,
      ),
    ).toBeNull();
  });

  it('returns null when the building has no kindoo_site_id (absent → home)', () => {
    const buildings = [
      building({ building_id: 'maple-building', building_name: 'Maple Building' }),
    ];
    expect(
      resolveWardSite(
        { building_id: 'maple-building', building_name: 'Maple Building' },
        buildings,
      ),
    ).toBeNull();
  });

  it('returns null when the building is unknown (missing → home)', () => {
    const buildings = [
      building({
        building_id: 'maple-building',
        building_name: 'Maple Building',
        kindoo_site_id: 'east-stake',
      }),
    ];
    expect(
      resolveWardSite({ building_id: 'nope', building_name: 'Nonexistent' }, buildings),
    ).toBeNull();
  });
});

describe('buildingNameById', () => {
  const buildings = [
    building({ building_id: 'pine-building', building_name: 'Pine Building' }),
    building({ building_id: 'maple-building', building_name: 'Maple Building' }),
  ];

  it('resolves a slug to the current display name', () => {
    expect(buildingNameById(buildings, 'pine-building')).toBe('Pine Building');
  });

  it('returns undefined for an unknown slug', () => {
    expect(buildingNameById(buildings, 'unknown')).toBeUndefined();
  });

  it('returns undefined for null / undefined / empty slug', () => {
    expect(buildingNameById(buildings, null)).toBeUndefined();
    expect(buildingNameById(buildings, undefined)).toBeUndefined();
    expect(buildingNameById(buildings, '')).toBeUndefined();
  });
});
