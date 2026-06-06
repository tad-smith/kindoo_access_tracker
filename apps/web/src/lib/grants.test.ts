// Unit tests for the per-grant view expansion used by Phase B
// multi-row rendering + broadened-inclusion roster surfaces.

import { describe, expect, it } from 'vitest';
import type { DuplicateGrant } from '@kindoo/shared';
import { makeSeat } from '../../test/fixtures';
import {
  collapseSameScopeGrants,
  grantsForDisplay,
  pickGrantForScope,
  resolveGrantOrgId,
} from './grants';

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

  it("falls back to primary's building_names when a same-site duplicate omits its own", () => {
    // Same-site (both unset → both home) duplicate inherits the
    // primary's buildings — within-site priority losers are covered
    // by the primary's Kindoo write, so the primary's buildings ARE
    // this grant's buildings.
    const seat = makeSeat({
      building_names: ['Primary Building'],
      duplicate_grants: [{ scope: 'CO', type: 'auto', detected_at: NOW }],
    });
    const [, dup] = grantsForDisplay(seat);
    expect(dup!.building_names).toEqual(['Primary Building']);
  });

  // T-43 follow-up: a parallel-site duplicate's buildings live on a
  // different Kindoo site than the primary; rendering the primary's
  // home-site buildings on a foreign-site row would be wrong data.
  // The fallback degrades to an empty list instead.
  it('renders an empty list (NOT the primary buildings) when a parallel-site duplicate omits building_names', () => {
    const seat = makeSeat({
      // Primary is home-site with home buildings.
      kindoo_site_id: null,
      building_names: ['Home Building'],
      duplicate_grants: [
        // Parallel-site duplicate without building_names — legacy /
        // pre-migration shape. Phase A's per-site provisioner stamps
        // building_names on every parallel-site duplicate going
        // forward, so this is the graceful-degradation path.
        { scope: 'FN', type: 'auto', kindoo_site_id: 'east-stake', detected_at: NOW },
      ],
    });
    const [primary, dup] = grantsForDisplay(seat);
    expect(primary!.building_names).toEqual(['Home Building']);
    expect(dup!.isParallelSite).toBe(true);
    // Home-site buildings must NOT leak onto the foreign-site row.
    expect(dup!.building_names).toEqual([]);
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
      duplicate_grants: [{ scope: 'CO', type: 'manual', kindoo_site_id: null, detected_at: NOW }],
    });
    const grant = pickGrantForScope(seat, 'CO');
    expect(grant?.isPrimary).toBe(true);
  });

  // Same-scope collapse on roster pages: a same-scope DuplicateGrant
  // contributes its buildings to the picked grant's row rather than
  // rendering a separate row (which roster pages don't do anyway).
  it('unions building_names from same-scope duplicates into the picked row', () => {
    const seat = makeSeat({
      scope: 'MH',
      type: 'auto',
      building_names: ['Jamboree'],
      duplicate_grants: [
        {
          scope: 'MH',
          type: 'manual',
          building_names: ['Lexington', 'Jamboree', 'Monument'],
          detected_at: NOW,
        },
      ],
    });
    const grant = pickGrantForScope(seat, 'MH');
    expect(grant?.isPrimary).toBe(true);
    expect(grant?.hasSameScopeDuplicates).toBe(true);
    expect(grant?.building_names).toEqual(['Jamboree', 'Lexington', 'Monument']);
  });

  it('flags hasSameScopeDuplicates=false when no same-scope duplicates exist', () => {
    const seat = makeSeat({ scope: 'CO', duplicate_grants: [] });
    expect(pickGrantForScope(seat, 'CO')?.hasSameScopeDuplicates).toBe(false);
  });
});

describe('collapseSameScopeGrants', () => {
  // Operator-reported case: a seat with an auto primary at scope MH
  // (buildings=['Jamboree']) and a manual DuplicateGrant at the SAME
  // scope MH (buildings=['Lexington', 'Jamboree', 'Monument']) must
  // render as ONE row whose buildings are the union of both, with
  // `hasSameScopeDuplicates=true` so the caller can show the
  // "Duplicate" badge with the operator-facing tooltip.
  it('collapses a same-scope different-type duplicate into one row with the union of buildings', () => {
    const seat = makeSeat({
      scope: 'MH',
      type: 'auto',
      member_canonical: 'user2@example.com',
      member_email: 'user2@example.com',
      member_name: 'Test User Two',
      building_names: ['Jamboree'],
      duplicate_grants: [
        {
          scope: 'MH',
          type: 'manual',
          building_names: ['Lexington', 'Jamboree', 'Monument'],
          detected_at: NOW,
        },
      ],
    });
    const views = collapseSameScopeGrants(grantsForDisplay(seat));
    expect(views).toHaveLength(1);
    const [row] = views;
    expect(row!.scope).toBe('MH');
    expect(row!.isPrimary).toBe(true);
    expect(row!.hasSameScopeDuplicates).toBe(true);
    expect(row!.building_names).toEqual(['Jamboree', 'Lexington', 'Monument']);
  });

  it('primary only → one view, primary buildings, no same-scope flag', () => {
    const seat = makeSeat({
      scope: 'CO',
      building_names: ['Primary Building'],
      duplicate_grants: [],
    });
    const views = collapseSameScopeGrants(grantsForDisplay(seat));
    expect(views).toHaveLength(1);
    expect(views[0]!.isPrimary).toBe(true);
    expect(views[0]!.building_names).toEqual(['Primary Building']);
    expect(views[0]!.hasSameScopeDuplicates).toBe(false);
  });

  it('primary + same-scope same-type duplicate → one row, union, flag set', () => {
    const seat = makeSeat({
      scope: 'CO',
      type: 'manual',
      callings: [],
      reason: 'primary reason',
      building_names: ['A Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['B Building'],
          reason: 'dup reason',
          detected_at: NOW,
        },
      ],
    });
    const views = collapseSameScopeGrants(grantsForDisplay(seat));
    expect(views).toHaveLength(1);
    expect(views[0]!.isPrimary).toBe(true);
    expect(views[0]!.building_names).toEqual(['A Building', 'B Building']);
    expect(views[0]!.hasSameScopeDuplicates).toBe(true);
    // The chosen view keeps the primary's reason — collapse merges
    // buildings, not free-text fields.
    expect(views[0]!.reason).toBe('primary reason');
  });

  it('primary + cross-scope duplicate → two rows unchanged (collapse only fires within a scope)', () => {
    const seat = makeSeat({
      scope: 'stake',
      kindoo_site_id: null,
      duplicate_grants: [
        { scope: 'CO', type: 'auto', building_names: ['CO Building'], detected_at: NOW },
      ],
    });
    const views = collapseSameScopeGrants(grantsForDisplay(seat));
    expect(views.map((v) => v.scope)).toEqual(['stake', 'CO']);
    expect(views[0]!.isPrimary).toBe(true);
    expect(views[1]!.isPrimary).toBe(false);
    expect(views[0]!.hasSameScopeDuplicates).toBe(false);
    expect(views[1]!.hasSameScopeDuplicates).toBe(false);
  });

  it('two same-scope duplicates with primary at a different scope → one row at the duplicate scope with union', () => {
    const seat = makeSeat({
      scope: 'stake',
      kindoo_site_id: null,
      building_names: ['Stake Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['CO Building A'],
          detected_at: NOW,
        },
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['CO Building B'],
          detected_at: NOW,
        },
      ],
    });
    const views = collapseSameScopeGrants(grantsForDisplay(seat));
    expect(views).toHaveLength(2);
    // Stake row unchanged.
    expect(views[0]!.scope).toBe('stake');
    expect(views[0]!.building_names).toEqual(['Stake Building']);
    expect(views[0]!.hasSameScopeDuplicates).toBe(false);
    // CO row collapses the two duplicates into one.
    expect(views[1]!.scope).toBe('CO');
    expect(views[1]!.isPrimary).toBe(false);
    expect(views[1]!.hasSameScopeDuplicates).toBe(true);
    expect(views[1]!.building_names).toEqual(['CO Building A', 'CO Building B']);
  });

  it('union dedupes shared building names and preserves the primary-first order', () => {
    const seat = makeSeat({
      scope: 'CO',
      building_names: ['B1', 'B2'],
      duplicate_grants: [
        { scope: 'CO', type: 'manual', building_names: ['B2', 'B3'], detected_at: NOW },
        { scope: 'CO', type: 'manual', building_names: ['B1', 'B4'], detected_at: NOW },
      ],
    });
    const views = collapseSameScopeGrants(grantsForDisplay(seat));
    expect(views).toHaveLength(1);
    expect(views[0]!.building_names).toEqual(['B1', 'B2', 'B3', 'B4']);
  });
});

describe('resolveGrantOrgId', () => {
  it('reads the seat top-level organization_id for the primary grant', () => {
    const seat = makeSeat({ scope: 'stake', organization_id: 'choir', duplicate_grants: [] });
    const [primary] = grantsForDisplay(seat);
    expect(resolveGrantOrgId(seat, primary!)).toBe('choir');
  });

  it('returns null for a primary grant with no organization', () => {
    const seat = makeSeat({ scope: 'stake', duplicate_grants: [] });
    const [primary] = grantsForDisplay(seat);
    expect(resolveGrantOrgId(seat, primary!)).toBeNull();
  });

  it("reads the duplicate's own organization_id for a duplicate grant", () => {
    const seat = makeSeat({
      scope: 'CO',
      organization_id: 'choir',
      duplicate_grants: [
        {
          scope: 'stake',
          type: 'manual',
          kindoo_site_id: null,
          organization_id: 'youth',
          detected_at: NOW,
        },
      ],
    });
    const [, dup] = grantsForDisplay(seat);
    // The duplicate carries its own org, not the seat's primary org.
    expect(resolveGrantOrgId(seat, dup!)).toBe('youth');
  });

  it('returns null when a duplicate grant has no organization', () => {
    const seat = makeSeat({
      scope: 'CO',
      organization_id: 'choir',
      duplicate_grants: [
        { scope: 'stake', type: 'manual', kindoo_site_id: null, detected_at: NOW },
      ],
    });
    const [, dup] = grantsForDisplay(seat);
    expect(resolveGrantOrgId(seat, dup!)).toBeNull();
  });
});
