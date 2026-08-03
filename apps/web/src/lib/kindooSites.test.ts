// Unit tests for the Kindoo-site helpers (spec §15 Phase 2).

import { describe, expect, it } from 'vitest';
import type { Building, KindooSite, Ward } from '@kindoo/shared';
import {
  filterBuildingsBySite,
  homeSiteName,
  remoteApplyTargetSiteKey,
  siteIdForScope,
  siteKeyLabel,
  siteLabelForGrant,
  siteLabelForSeat,
} from './kindooSites';

const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const actor = { email: 'a@b.c', canonical: 'a@b.c' };

// A ward's Kindoo site is derived from its building, so the fixture
// binds the ward to a `building_name`; the building carries the site.
function ward(code: string, building_name = ''): Ward {
  return {
    ward_code: code,
    ward_name: `Ward ${code}`,
    building_name,
    seat_cap: 20,
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: actor,
  } as unknown as Ward;
}

function building(name: string, kindoo_site_id?: string | null): Building {
  return {
    building_id: name.toLowerCase(),
    building_name: name,
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
    expect(siteIdForScope('stake', [], [])).toBeNull();
  });

  it('returns null for an empty scope', () => {
    expect(siteIdForScope('', [], [])).toBeNull();
  });

  it('returns null for a ward not in the catalogue', () => {
    expect(siteIdForScope('CO', [], [])).toBeNull();
  });

  it('returns null for a ward whose building is on the home site', () => {
    expect(
      siteIdForScope('CO', [ward('CO', 'Maple Building')], [building('Maple Building', null)]),
    ).toBeNull();
  });

  it('treats a ward whose building has no site as home (returns null)', () => {
    expect(
      siteIdForScope('CO', [ward('CO', 'Maple Building')], [building('Maple Building')]),
    ).toBeNull();
  });

  it("returns the building's site for a foreign-site ward", () => {
    expect(
      siteIdForScope('FN', [ward('FN', 'Pine Building')], [building('Pine Building', 'foreign-1')]),
    ).toBe('foreign-1');
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
    expect(siteLabelForSeat({ scope: 'stake' }, [], [], [])).toBeNull();
  });

  it('returns null for an unknown ward', () => {
    expect(siteLabelForSeat({ scope: 'CO' }, [], [], [])).toBeNull();
  });

  it('returns null for a home-site ward', () => {
    expect(
      siteLabelForSeat(
        { scope: 'CO' },
        [ward('CO', 'Maple Building')],
        [building('Maple Building', null)],
        [],
      ),
    ).toBeNull();
  });

  it("returns the foreign site's display_name for a foreign-site ward", () => {
    expect(
      siteLabelForSeat(
        { scope: 'FN' },
        [ward('FN', 'Pine Building')],
        [building('Pine Building', 'foreign-1')],
        [site('foreign-1', 'East Stake')],
      ),
    ).toBe('East Stake');
  });

  it('returns null when the foreign-site doc has not loaded yet', () => {
    expect(
      siteLabelForSeat(
        { scope: 'FN' },
        [ward('FN', 'Pine Building')],
        [building('Pine Building', 'foreign-1')],
        [],
      ),
    ).toBeNull();
  });
});

describe('siteLabelForGrant', () => {
  it('returns null for stake-scope grants (home-only per Phase 1)', () => {
    expect(siteLabelForGrant({ scope: 'stake', kindoo_site_id: null }, [], [], [])).toBeNull();
  });

  it("returns the foreign site's display_name when the grant carries its own kindoo_site_id", () => {
    expect(
      siteLabelForGrant(
        { scope: 'CO', kindoo_site_id: 'foreign-1' },
        [],
        [],
        [site('foreign-1', 'East')],
      ),
    ).toBe('East');
  });

  it('returns null for a home grant (kindoo_site_id null) with no ward fallback', () => {
    expect(siteLabelForGrant({ scope: 'CO', kindoo_site_id: null }, [], [], [])).toBeNull();
  });

  it('falls back to the ward building when the grant has no kindoo_site_id (legacy)', () => {
    expect(
      siteLabelForGrant(
        { scope: 'FN', kindoo_site_id: null },
        [ward('FN', 'Pine Building')],
        [building('Pine Building', 'foreign-1')],
        [site('foreign-1', 'East')],
      ),
    ).toBe('East');
  });

  // Phase B fallback: a grant with `kindoo_site_id: null` falls
  // through the ward → building lookup so legacy / pre-migration data
  // still resolves the foreign badge correctly (the spec accepts this
  // ambiguity — the migration is a hard prerequisite, and after it
  // runs every grant carries a non-null site for foreign scopes).
  it("falls back to the ward building when the grant's kindoo_site_id is null (legacy / pre-migration)", () => {
    expect(
      siteLabelForGrant(
        { scope: 'CO', kindoo_site_id: null },
        [ward('CO', 'Pine Building')],
        [building('Pine Building', 'foreign-1')],
        [site('foreign-1', 'East')],
      ),
    ).toBe('East');
  });

  it("returns the grant's own foreign label even when the ward is on a different site", () => {
    expect(
      siteLabelForGrant(
        { scope: 'CO', kindoo_site_id: 'foreign-2' },
        [ward('CO', 'Pine Building')],
        [building('Pine Building', 'foreign-1')],
        [site('foreign-1', 'East'), site('foreign-2', 'West')],
      ),
    ).toBe('West');
  });
});

describe('remoteApplyTargetSiteKey', () => {
  it('sends a stake-scope request to the home site', () => {
    expect(remoteApplyTargetSiteKey('stake', [], [])).toBe('home');
  });

  it("sends a ward request to its building's foreign site", () => {
    expect(
      remoteApplyTargetSiteKey(
        'CO',
        [ward('CO', 'Pine Building')],
        [building('Pine Building', 'foreign-1')],
      ),
    ).toBe('foreign-1');
  });

  it('sends a ward on a home-site building to the home key, not to null', () => {
    // Home is a site like any other for remote apply — a home request
    // must not be servable by a tab parked on a foreign site.
    expect(
      remoteApplyTargetSiteKey(
        'CO',
        [ward('CO', 'Maple Building')],
        [building('Maple Building', null)],
      ),
    ).toBe('home');
  });

  it('treats a legacy building with no site field as home', () => {
    expect(
      remoteApplyTargetSiteKey('CO', [ward('CO', 'Maple Building')], [building('Maple Building')]),
    ).toBe('home');
  });

  it('refuses to guess when the ward is not in the catalogue', () => {
    // Fail closed: an unresolvable target can't be routed to a desktop,
    // so the phone must not offer a button for it.
    expect(remoteApplyTargetSiteKey('CO', [], [])).toBeNull();
  });

  it("refuses to guess when the ward's building reference is orphaned", () => {
    expect(remoteApplyTargetSiteKey('CO', [ward('CO', 'Gone Building')], [])).toBeNull();
  });

  it('refuses to guess for an empty scope', () => {
    expect(remoteApplyTargetSiteKey('', [], [])).toBeNull();
  });
});

describe('siteKeyLabel', () => {
  it('names the home site from the stake, which has no catalogue doc', () => {
    expect(siteKeyLabel('home', [], 'Colorado Springs North')).toBe('Colorado Springs North');
  });

  it('names a foreign site from the catalogue', () => {
    expect(siteKeyLabel('foreign-1', [site('foreign-1', 'East Stake')], 'Home')).toBe('East Stake');
  });

  it('has no name for a site the catalogue does not carry', () => {
    expect(siteKeyLabel('ghost', [], 'Home')).toBeNull();
  });
});

describe('homeSiteName', () => {
  it("prefers the name Kindoo itself shows for the stake's site", () => {
    expect(
      homeSiteName({
        stake_name: 'CS North Stake',
        kindoo_expected_site_name: 'Expected Name',
        kindoo_config: {
          site_id: 42,
          site_name: 'Colorado Springs North',
          configured_at: stamp,
          configured_by: actor,
        },
      }),
    ).toBe('Colorado Springs North');
  });

  it('falls back to the expected-name override before the stake name', () => {
    expect(
      homeSiteName({ stake_name: 'STAGING - CS North', kindoo_expected_site_name: 'CS North' }),
    ).toBe('CS North');
  });

  it('falls back to the stake name when Kindoo was never configured', () => {
    expect(homeSiteName({ stake_name: 'CS North Stake' })).toBe('CS North Stake');
  });

  it('has no name before the stake doc has loaded', () => {
    expect(homeSiteName(undefined)).toBeNull();
  });
});
