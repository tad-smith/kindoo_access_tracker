// Unit tests for the per-grant view expansion used by Phase B
// multi-row rendering + broadened-inclusion roster surfaces.

import { describe, expect, it } from 'vitest';
import type { DuplicateGrant } from '@kindoo/shared';
import { makeSeat } from '../../test/fixtures';
import { grantsForDisplay, pickGrantForScope } from './grants';

const NOW: DuplicateGrant['detected_at'] = {
  seconds: 0,
  nanoseconds: 0,
  toDate: () => new Date(),
  toMillis: () => 0,
};

describe('grantsForDisplay', () => {
  it('returns one view (the primary) for a seat with no duplicates', () => {
    const seat = makeSeat({ scope: 'CO', duplicate_grants: [] });
    const views = grantsForDisplay(seat);
    expect(views).toHaveLength(1);
    expect(views[0]!.isPrimary).toBe(true);
    expect(views[0]!.scope).toBe('CO');
    expect(views[0]!.isParallelSite).toBe(false);
    expect(views[0]!.duplicateIndex).toBe(-1);
  });

  it('returns one view per grant: primary first, duplicates in array order', () => {
    const seat = makeSeat({
      scope: 'stake',
      kindoo_site_id: null,
      duplicate_grants: [
        { scope: 'CO', type: 'auto', kindoo_site_id: null, detected_at: NOW },
        { scope: 'FN', type: 'auto', kindoo_site_id: 'foreign-1', detected_at: NOW },
      ],
    });
    const views = grantsForDisplay(seat);
    expect(views.map((v) => v.scope)).toEqual(['stake', 'CO', 'FN']);
    expect(views.map((v) => v.isPrimary)).toEqual([true, false, false]);
    expect(views.map((v) => v.duplicateIndex)).toEqual([-1, 0, 1]);
  });

  it('marks a duplicate as isParallelSite when its kindoo_site_id differs from the primary', () => {
    const seat = makeSeat({
      kindoo_site_id: null,
      duplicate_grants: [{ scope: 'FN', type: 'auto', kindoo_site_id: 'east', detected_at: NOW }],
    });
    const [, dup] = grantsForDisplay(seat);
    expect(dup!.isParallelSite).toBe(true);
  });

  it('marks a within-site duplicate (same kindoo_site_id) as NOT isParallelSite', () => {
    const seat = makeSeat({
      kindoo_site_id: 'east',
      duplicate_grants: [{ scope: 'CO', type: 'auto', kindoo_site_id: 'east', detected_at: NOW }],
    });
    const [, dup] = grantsForDisplay(seat);
    expect(dup!.isParallelSite).toBe(false);
  });

  it('legacy seats (kindoo_site_id absent on both) render isParallelSite=false (graceful no-op)', () => {
    const seat = makeSeat({
      duplicate_grants: [{ scope: 'CO', type: 'auto', detected_at: NOW }],
    });
    const [primary, dup] = grantsForDisplay(seat);
    expect(primary!.kindoo_site_id).toBeNull();
    expect(dup!.kindoo_site_id).toBeNull();
    expect(dup!.isParallelSite).toBe(false);
  });

  it('treats kindoo_site_id="" and missing as equivalent to null (home)', () => {
    const seat = makeSeat({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kindoo_site_id: '' as any,
      duplicate_grants: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { scope: 'CO', type: 'auto', kindoo_site_id: '' as any, detected_at: NOW },
      ],
    });
    const [primary, dup] = grantsForDisplay(seat);
    expect(primary!.kindoo_site_id).toBeNull();
    expect(dup!.isParallelSite).toBe(false);
  });

  it("falls back to primary's building_names when a duplicate omits its own", () => {
    const seat = makeSeat({
      building_names: ['Primary Building'],
      duplicate_grants: [{ scope: 'CO', type: 'auto', detected_at: NOW }],
    });
    const [, dup] = grantsForDisplay(seat);
    expect(dup!.building_names).toEqual(['Primary Building']);
  });

  it("uses the duplicate's own building_names when set", () => {
    const seat = makeSeat({
      building_names: ['Primary Building'],
      duplicate_grants: [
        {
          scope: 'FN',
          type: 'auto',
          kindoo_site_id: 'east',
          building_names: ['Foreign Building'],
          detected_at: NOW,
        },
      ],
    });
    const [, dup] = grantsForDisplay(seat);
    expect(dup!.building_names).toEqual(['Foreign Building']);
  });

  it('threads reason / start_date / end_date through to the per-grant view', () => {
    const seat = makeSeat({
      type: 'temp',
      callings: [],
      reason: 'pri-reason',
      start_date: '2026-06-01',
      end_date: '2026-06-30',
      duplicate_grants: [
        {
          scope: 'FN',
          type: 'temp',
          kindoo_site_id: 'east',
          reason: 'dup-reason',
          start_date: '2026-06-05',
          end_date: '2026-06-25',
          detected_at: NOW,
        },
      ],
    });
    const [primary, dup] = grantsForDisplay(seat);
    expect(primary!.reason).toBe('pri-reason');
    expect(primary!.start_date).toBe('2026-06-01');
    expect(dup!.reason).toBe('dup-reason');
    expect(dup!.start_date).toBe('2026-06-05');
    expect(dup!.end_date).toBe('2026-06-25');
  });
});

describe('pickGrantForScope', () => {
  it('returns the primary when its scope matches', () => {
    const seat = makeSeat({ scope: 'CO', duplicate_grants: [] });
    expect(pickGrantForScope(seat, 'CO')?.isPrimary).toBe(true);
  });

  it('returns the first matching duplicate when the primary does not match', () => {
    const seat = makeSeat({
      scope: 'stake',
      duplicate_grants: [
        { scope: 'GE', type: 'auto', detected_at: NOW },
        { scope: 'CO', type: 'auto', detected_at: NOW },
      ],
    });
    const grant = pickGrantForScope(seat, 'CO');
    expect(grant?.isPrimary).toBe(false);
    expect(grant?.scope).toBe('CO');
    expect(grant?.duplicateIndex).toBe(1);
  });

  it('returns null when no grant matches the scope', () => {
    const seat = makeSeat({ scope: 'CO', duplicate_grants: [] });
    expect(pickGrantForScope(seat, 'GE')).toBeNull();
  });

  // T-43 reviewer fix: with multiple grants at the same scope (a stake
  // primary + a home-site CO duplicate + a foreign-site CO duplicate),
  // the per-scope roster picks ONE row per person deterministically.
  it('prefers a home-site duplicate over a foreign-site duplicate when primary does not match', () => {
    const seat = makeSeat({
      scope: 'stake',
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'auto',
          kindoo_site_id: 'east-stake',
          detected_at: NOW,
        },
        { scope: 'CO', type: 'auto', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    const grant = pickGrantForScope(seat, 'CO');
    expect(grant?.kindoo_site_id).toBeNull();
    expect(grant?.duplicateIndex).toBe(1);
  });

  it('falls back to lowest-`kindoo_site_id` when only foreign-site duplicates match', () => {
    const seat = makeSeat({
      scope: 'stake',
      kindoo_site_id: null,
      duplicate_grants: [
        { scope: 'CO', type: 'auto', kindoo_site_id: 'west-stake', detected_at: NOW },
        { scope: 'CO', type: 'auto', kindoo_site_id: 'east-stake', detected_at: NOW },
      ],
    });
    const grant = pickGrantForScope(seat, 'CO');
    expect(grant?.kindoo_site_id).toBe('east-stake');
  });

  it('primary wins even when same-scope duplicates also match', () => {
    // Same-scope dupes are rare but legal (priority loser); the
    // primary is still the row's home record.
    const seat = makeSeat({
      scope: 'CO',
      kindoo_site_id: null,
      duplicate_grants: [
        { scope: 'CO', type: 'manual', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    const grant = pickGrantForScope(seat, 'CO');
    expect(grant?.isPrimary).toBe(true);
  });
});
