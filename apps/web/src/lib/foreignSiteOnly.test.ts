// Unit tests for the foreign-site-only detection that gates the
// "Give Access To Stake Buildings" manager affordance.

import { describe, expect, it } from 'vitest';
import type { Building, DuplicateGrant, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../test/fixtures';
import { hasStakeScopeGrant, isForeignSiteOnly, stakeAccessNoteGrant } from './foreignSiteOnly';

const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const NOW: DuplicateGrant['detected_at'] = stamp;

function building(name: string, kindoo_site_id: string | null): Building {
  return {
    building_id: name.toLowerCase().replace(/\s+/g, '-'),
    building_name: name,
    address: '',
    kindoo_site_id,
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
  } as unknown as Building;
}

// CO ward sits on the home site; FN sits on a foreign site.
const WARDS: Ward[] = [
  makeWard({ ward_code: 'CO', building_name: 'Home Building' }),
  makeWard({ ward_code: 'FN', building_name: 'Foreign Building' }),
];
const BUILDINGS: Building[] = [
  building('Home Building', null),
  building('Foreign Building', 'east-stake'),
];

describe('isForeignSiteOnly', () => {
  it('returns true for a single foreign-site ward grant (id on the grant)', () => {
    const seat = makeSeat({
      scope: 'FN',
      type: 'manual',
      callings: [],
      kindoo_site_id: 'east-stake',
    });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(true);
  });

  it('returns true for a legacy foreign-site grant resolved through the ward building', () => {
    // Grant carries no kindoo_site_id; the FN ward's building binds it
    // to the foreign site, so the fallback resolves it foreign.
    const seat = makeSeat({ scope: 'FN', type: 'manual', callings: [] });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(true);
  });

  it('returns false when any grant resolves to the home site', () => {
    const seat = makeSeat({ scope: 'CO', type: 'manual', callings: [], kindoo_site_id: null });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(false);
  });

  it('returns false when the seat carries a stake-scope primary grant', () => {
    const seat = makeSeat({ scope: 'stake', type: 'manual', callings: [], kindoo_site_id: null });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(false);
  });

  it('returns false when a stake-scope duplicate grant exists alongside a foreign primary', () => {
    const seat = makeSeat({
      scope: 'FN',
      type: 'manual',
      callings: [],
      kindoo_site_id: 'east-stake',
      duplicate_grants: [
        { scope: 'stake', type: 'manual', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(false);
  });

  it('returns false when a home-site duplicate grant exists alongside a foreign primary', () => {
    const seat = makeSeat({
      scope: 'FN',
      type: 'manual',
      callings: [],
      kindoo_site_id: 'east-stake',
      duplicate_grants: [{ scope: 'CO', type: 'manual', kindoo_site_id: null, detected_at: NOW }],
    });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(false);
  });

  it('returns true when every grant (primary + duplicate) is foreign-site', () => {
    const seat = makeSeat({
      scope: 'FN',
      type: 'manual',
      callings: [],
      kindoo_site_id: 'east-stake',
      duplicate_grants: [
        {
          scope: 'FN',
          type: 'manual',
          kindoo_site_id: 'west-stake',
          building_names: ['Other Foreign'],
          detected_at: NOW,
        },
      ],
    });
    expect(isForeignSiteOnly(seat, WARDS, BUILDINGS)).toBe(true);
  });
});

describe('hasStakeScopeGrant', () => {
  it('returns true when the primary grant is stake-scope', () => {
    expect(hasStakeScopeGrant(makeSeat({ scope: 'stake' }))).toBe(true);
  });

  it('returns true when a duplicate grant is stake-scope', () => {
    const seat = makeSeat({
      scope: 'FN',
      duplicate_grants: [
        { scope: 'stake', type: 'manual', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    expect(hasStakeScopeGrant(seat)).toBe(true);
  });

  it('returns false when no grant is stake-scope', () => {
    expect(hasStakeScopeGrant(makeSeat({ scope: 'FN' }))).toBe(false);
  });
});

describe('stakeAccessNoteGrant', () => {
  const call = (seat: Parameters<typeof stakeAccessNoteGrant>[0]) =>
    stakeAccessNoteGrant(seat, WARDS, BUILDINGS);

  it('returns null without a stake grant — that member should get the BUTTON', () => {
    // The precondition that used to live in the caller. Without it the
    // helper answers for a foreign-site-only member, and a second caller
    // would tell them they already have access they don't have.
    expect(call(makeSeat({ scope: 'FN', type: 'manual', callings: [] }))).toBeNull();
  });

  it('returns the foreign grant for a stake primary + foreign duplicate (B-23 shape)', () => {
    const seat = makeSeat({
      scope: 'stake',
      duplicate_grants: [
        { scope: 'FN', type: 'auto', kindoo_site_id: 'east-stake', detected_at: NOW },
      ],
    });
    expect(call(seat)?.scope).toBe('FN');
  });

  it('returns the foreign grant for a foreign primary + stake duplicate', () => {
    const seat = makeSeat({
      scope: 'FN',
      duplicate_grants: [
        { scope: 'stake', type: 'manual', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    expect(call(seat)?.scope).toBe('FN');
  });

  it('returns null when a HOME-site ward grant disqualifies the member anyway', () => {
    // The stake grant is then not the only thing standing between them and
    // the button, so naming it as the reason would be false.
    const seat = makeSeat({
      scope: 'CO',
      duplicate_grants: [
        { scope: 'FN', type: 'manual', kindoo_site_id: 'east-stake', detected_at: NOW },
        { scope: 'stake', type: 'manual', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    expect(call(seat)).toBeNull();
  });

  it('returns null for a stake-only seat — the affordance was never relevant', () => {
    expect(call(makeSeat({ scope: 'stake' }))).toBeNull();
  });
});
