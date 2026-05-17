// Unit tests for the Kindoo-site helpers (spec §15 Phase 2).

import { describe, expect, it } from 'vitest';
import type { Building, KindooSite, Ward } from '@kindoo/shared';
import {
  filterBuildingsBySite,
  siteIdForScope,
  siteLabelForGrant,
  siteLabelForSeat,
} from './kindooSites';

const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const actor = { email: 'a@b.c', canonical: 'a@b.c' };

function ward(code: string, kindoo_site_id?: string | null): Ward {
  return {
    ward_code: code,
    ward_name: `Ward ${code}`,
    building_name: '',
    seat_cap: 20,
    ...(kindoo_site_id !== undefined ? { kindoo_site_id } : {}),
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: actor,
  } as unknown as Ward;
}

function building(id: string, kindoo_site_id?: string | null): Building {
  return {
    building_id: id,
    building_name: `${id}-name`,
    address: '',
    ...(kindoo_site_id !== undefined ? { kindoo_site_id } : {}),
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: actor,
  } as unknown as Building;
}

function site(id: string, display_name: string): KindooSite {
  return {
    id,
    display_name,
    kindoo_expected_site_name: '',
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: actor,
  } as unknown as KindooSite;
}

describe('siteIdForScope', () => {
  it('returns null for the stake scope (home-only per spec §15)', () => {
    expect(siteIdForScope('stake', [])).toBeNull();
  });

  it('returns null for an empty scope', () => {
    expect(siteIdForScope('', [])).toBeNull();
  });

  it('returns null for a ward not in the catalogue', () => {
    expect(siteIdForScope('CO', [])).toBeNull();
  });

  it('returns null for a ward whose kindoo_site_id is null (home)', () => {
    expect(siteIdForScope('CO', [ward('CO', null)])).toBeNull();
  });

  it('treats a ward with absent kindoo_site_id as home (returns null)', () => {
    expect(siteIdForScope('CO', [ward('CO')])).toBeNull();
  });

  it('returns the kindoo_site_id for a foreign-site ward', () => {
    expect(siteIdForScope('FN', [ward('FN', 'foreign-1')])).toBe('foreign-1');
  });
});

describe('filterBuildingsBySite', () => {
  it('keeps only home buildings when siteId is null', () => {
    const result = filterBuildingsBySite(
      [building('a', null), building('b', 'foreign-1'), building('c')],
      null,
    );
    expect(result.map((b) => b.building_id)).toEqual(['a', 'c']);
  });

  it('keeps only matching foreign-site buildings when siteId is set', () => {
    const result = filterBuildingsBySite(
      [building('a', null), building('b', 'foreign-1'), building('c', 'foreign-2')],
      'foreign-1',
    );
    expect(result.map((b) => b.building_id)).toEqual(['b']);
  });

  it('returns empty when no buildings match', () => {
    expect(filterBuildingsBySite([building('a', null)], 'foreign-1')).toEqual([]);
  });
});

describe('siteLabelForSeat', () => {
  it('returns null for a stake-scope seat', () => {
    expect(siteLabelForSeat({ scope: 'stake' }, [], [])).toBeNull();
  });

  it('returns null for an unknown ward', () => {
    expect(siteLabelForSeat({ scope: 'CO' }, [], [])).toBeNull();
  });

  it('returns null for a home-site ward', () => {
    expect(siteLabelForSeat({ scope: 'CO' }, [ward('CO', null)], [])).toBeNull();
  });

  it("returns the foreign site's display_name for a foreign-site ward", () => {
    expect(
      siteLabelForSeat(
        { scope: 'FN' },
        [ward('FN', 'foreign-1')],
        [site('foreign-1', 'East Stake')],
      ),
    ).toBe('East Stake');
  });

  it('returns null when the foreign-site doc has not loaded yet', () => {
    expect(siteLabelForSeat({ scope: 'FN' }, [ward('FN', 'foreign-1')], [])).toBeNull();
  });
});

describe('siteLabelForGrant', () => {
  it('returns null for stake-scope grants (home-only per Phase 1)', () => {
    expect(siteLabelForGrant({ scope: 'stake', kindoo_site_id: null }, [], [])).toBeNull();
  });

  it("returns the foreign site's display_name when the grant carries its own kindoo_site_id", () => {
    expect(
      siteLabelForGrant(
        { scope: 'CO', kindoo_site_id: 'foreign-1' },
        [],
        [site('foreign-1', 'East')],
      ),
    ).toBe('East');
  });

  it('returns null for a home grant (kindoo_site_id null) with no ward fallback', () => {
    expect(siteLabelForGrant({ scope: 'CO', kindoo_site_id: null }, [], [])).toBeNull();
  });

  it('falls back to ward lookup when the grant has no kindoo_site_id (legacy)', () => {
    expect(
      siteLabelForGrant(
        { scope: 'FN', kindoo_site_id: null },
        [ward('FN', 'foreign-1')],
        [site('foreign-1', 'East')],
      ),
    ).toBe('East');
  });

  // Phase B fallback: a grant with `kindoo_site_id: null` falls
  // through the ward lookup so legacy / pre-migration data still
  // resolves the foreign badge correctly (the spec accepts this
  // ambiguity — the migration is a hard prerequisite, and after it
  // runs every grant carries a non-null site for foreign scopes).
  it("falls back to ward lookup when the grant's kindoo_site_id is null (legacy / pre-migration)", () => {
    expect(
      siteLabelForGrant(
        { scope: 'CO', kindoo_site_id: null },
        [ward('CO', 'foreign-1')],
        [site('foreign-1', 'East')],
      ),
    ).toBe('East');
  });

  it("returns the grant's own foreign label even when the ward is on a different site", () => {
    expect(
      siteLabelForGrant(
        { scope: 'CO', kindoo_site_id: 'foreign-2' },
        [ward('CO', 'foreign-1')],
        [site('foreign-1', 'East'), site('foreign-2', 'West')],
      ),
    ).toBe('West');
  });
});
