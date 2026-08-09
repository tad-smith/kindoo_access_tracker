// Pins the typeahead's calling lists against the shared sort table.
//
// `standardCallings.ts` reproduces `@kindoo/shared`'s `CALLING_ORDER` by
// hand, because that table is module-private there and exposes only a
// name→order lookup. These tests are what stops the copy drifting: they
// reconstruct the shared table's shape through `callingSortOrder()` and
// assert the copy still matches it.
//
// The gap-free check is the one that matters. Seven branch callings
// landed in the shared table (T-96) and never reached the typeahead, and
// nothing failed — every remaining entry still resolved, and still
// resolved in ascending order. Only the holes they left in the index
// range make an omission visible from this side.

import { describe, expect, it } from 'vitest';
import { callingSortOrder, type Ward } from '@kindoo/shared';
import {
  BRANCH_CALLINGS,
  STAKE_CALLINGS,
  UNIT_CALLINGS,
  WARD_CALLINGS,
  callingsForScope,
} from '../standardCallings';

// The union is what the conformance checks run against. The split
// subtracts from it, so neither sub-list covers a contiguous index range
// on its own — only together do they still account for the whole table.
const ALL_CALLINGS = [...STAKE_CALLINGS, ...UNIT_CALLINGS];

function unit(code: string, name: string): Ward {
  return { ward_code: code, ward_name: name } as unknown as Ward;
}

const CATALOGUE: readonly Ward[] = [
  unit('CO', 'Maple Ward'),
  unit('peterson-branch', 'Peterson Branch'),
];

describe('standard calling lists', () => {
  it('offers branch callings on the unit list', () => {
    expect(UNIT_CALLINGS).toEqual(
      expect.arrayContaining([
        'Branch President',
        'Branch Presidency First Counselor',
        'Branch Presidency Second Counselor',
        'Branch Clerk',
        'Branch Assistant Clerk',
        'Branch Assistant Clerk--Membership',
        'Branch Assistant Clerk--Finance',
      ]),
    );
  });

  it('still offers the ward callings alongside them', () => {
    expect(UNIT_CALLINGS).toEqual(
      expect.arrayContaining([
        'Bishop',
        'Bishopric First Counselor',
        'Bishopric Second Counselor',
        'Ward Executive Secretary',
        'Ward Clerk',
        'Elders Quorum President',
        'Relief Society President',
        'Technology Specialist',
      ]),
    );
  });

  it('still offers the stake callings', () => {
    expect(STAKE_CALLINGS).toEqual(
      expect.arrayContaining([
        'Stake President',
        'Stake Presidency First Counselor',
        'Stake Clerk',
        'Stake Executive Secretary',
        'Stake High Councilor',
        'Patriarch',
      ]),
    );
  });

  it('ranks each branch calling immediately after its ward counterpart', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['Bishop', 'Branch President'],
      ['Bishopric First Counselor', 'Branch Presidency First Counselor'],
      ['Bishopric Second Counselor', 'Branch Presidency Second Counselor'],
      ['Ward Clerk', 'Branch Clerk'],
      ['Ward Assistant Clerk', 'Branch Assistant Clerk'],
      ['Ward Assistant Clerk--Membership', 'Branch Assistant Clerk--Membership'],
      ['Ward Assistant Clerk--Finance', 'Branch Assistant Clerk--Finance'],
    ];
    for (const [ward, branch] of pairs) {
      expect(UNIT_CALLINGS.indexOf(branch)).toBe(UNIT_CALLINGS.indexOf(ward) + 1);
    }
  });

  it('names no calling the shared sort table does not know', () => {
    const unknown = ALL_CALLINGS.filter((c) => callingSortOrder(c) === null);
    expect(unknown).toEqual([]);
  });

  it('lists every calling in the shared table order', () => {
    const orders = ALL_CALLINGS.map((c) => callingSortOrder(c));
    const ascending = orders.every((order, i) => i === 0 || order! > orders[i - 1]!);
    expect(ascending).toBe(true);
  });

  it('covers the shared table without gaps, so a new entry there cannot be silently dropped', () => {
    const orders = ALL_CALLINGS.map((c) => callingSortOrder(c)!);
    const covered = new Set(orders);
    // Contiguous 0..n-1: any entry present in the shared table but absent
    // here shifts its successors and leaves a hole in the range.
    const missing = Array.from({ length: Math.max(...orders) + 1 }, (_, i) => i).filter(
      (i) => !covered.has(i),
    );
    expect(missing).toEqual([]);
    expect(covered.size).toBe(ALL_CALLINGS.length);
  });

  it('loses no unit calling to the split — ward plus branch spans the union', () => {
    // The gap-free check above runs on the union, so an entry dropped
    // from BOTH sub-lists would escape it. This is what closes that.
    const spanned = new Set([...WARD_CALLINGS, ...BRANCH_CALLINGS]);
    expect([...UNIT_CALLINGS].filter((c) => !spanned.has(c))).toEqual([]);
  });

  it('hides every ward-only calling from a branch, and offers its counterpart', () => {
    const swapped: ReadonlyArray<readonly [string, string]> = [
      ['Bishop', 'Branch President'],
      ['Bishopric First Counselor', 'Branch Presidency First Counselor'],
      ['Bishopric Second Counselor', 'Branch Presidency Second Counselor'],
      ['Ward Clerk', 'Branch Clerk'],
      ['Ward Assistant Clerk', 'Branch Assistant Clerk'],
      ['Ward Assistant Clerk--Membership', 'Branch Assistant Clerk--Membership'],
      ['Ward Assistant Clerk--Finance', 'Branch Assistant Clerk--Finance'],
    ];
    for (const [ward, branch] of swapped) {
      expect(BRANCH_CALLINGS).not.toContain(ward);
      expect(BRANCH_CALLINGS).toContain(branch);
    }
  });

  it('hides both executive secretary callings from a branch with no replacement', () => {
    // A branch has no executive secretary at all — the same fact behind
    // T-96 omitting a "Branch Executive Secretary" from the shared table.
    expect(BRANCH_CALLINGS).not.toContain('Ward Executive Secretary');
    expect(BRANCH_CALLINGS).not.toContain('Ward Assistant Executive Secretary');
    expect(BRANCH_CALLINGS.filter((c) => /executive secretary/i.test(c))).toEqual([]);
  });

  it('carries the non-swapped unit callings over to a branch unchanged', () => {
    // T-96's four families are not an exhaustive whitelist: Sunday School,
    // Ward Mission Leader and the specialists reach a branch too.
    expect(BRANCH_CALLINGS).toEqual(
      expect.arrayContaining([
        'Elders Quorum President',
        'Relief Society President',
        'Primary President',
        'Young Women President',
        'Sunday School President',
        'Aaronic Priesthood Advisors',
        'Ward Mission Leader',
        'Ward Temple and Family History Leader',
        'Building Representative',
        'Technology Specialist',
      ]),
    );
  });

  it('offers no branch calling at a ward', () => {
    expect(WARD_CALLINGS.filter((c) => c.startsWith('Branch '))).toEqual([]);
  });

  it('leaves the ward list exactly as it was before branches existed', () => {
    // 43 entries — the unit band minus the seven branch-only additions.
    expect(WARD_CALLINGS).toHaveLength(UNIT_CALLINGS.length - 7);
    expect(WARD_CALLINGS).toEqual(
      expect.arrayContaining([
        'Bishop',
        'Bishopric First Counselor',
        'Ward Executive Secretary',
        'Ward Assistant Executive Secretary',
        'Ward Clerk',
        'Ward Assistant Clerk--Finance',
      ]),
    );
  });

  it('keeps both sub-lists in the shared table order', () => {
    for (const list of [WARD_CALLINGS, BRANCH_CALLINGS]) {
      const orders = list.map((c) => callingSortOrder(c)!);
      expect(orders.every((o, i) => i === 0 || o > orders[i - 1]!)).toBe(true);
    }
  });

  it('splits stake from unit callings at the Bishop boundary', () => {
    const lastStake = callingSortOrder(STAKE_CALLINGS[STAKE_CALLINGS.length - 1]!)!;
    const firstUnit = callingSortOrder(UNIT_CALLINGS[0]!)!;
    expect(UNIT_CALLINGS[0]).toBe('Bishop');
    expect(firstUnit).toBe(lastStake + 1);
  });
});

describe('callingsForScope', () => {
  it('resolves a branch by its name, not its code', () => {
    // `peterson-branch` is a slug; the ruling is that only the ward doc's
    // NAME decides the unit kind (D31).
    expect(callingsForScope('peterson-branch', CATALOGUE)).toBe(BRANCH_CALLINGS);
  });

  it('resolves a ward by its name', () => {
    expect(callingsForScope('CO', CATALOGUE)).toBe(WARD_CALLINGS);
  });

  it('reads a branch whose code looks nothing like its name', () => {
    // The slug is not derived from the name for legacy units, so a
    // two-letter code must still resolve to a branch.
    expect(callingsForScope('LB', [unit('LB', 'Lakeside Branch')])).toBe(BRANCH_CALLINGS);
  });

  it('does not mistake a ward named "…Branch Ward" for a branch', () => {
    expect(callingsForScope('OB', [unit('OB', 'Olive Branch Ward')])).toBe(WARD_CALLINGS);
  });

  it('offers the stake list at stake scope, whatever the catalogue holds', () => {
    expect(callingsForScope('stake', CATALOGUE)).toBe(STAKE_CALLINGS);
  });

  it('falls back to the combined unit list when the scope is not in the catalogue', () => {
    // Chosen over an empty list: `wards` comes from a live query, so every
    // scope is unresolvable mid-load and a blank typeahead would be a
    // regression. A superset never blocks — free text submits anyway.
    expect(callingsForScope('CO', [])).toBe(UNIT_CALLINGS);
    expect(callingsForScope('unknown-unit', CATALOGUE)).toBe(UNIT_CALLINGS);
    expect(callingsForScope('', CATALOGUE)).toBe(UNIT_CALLINGS);
  });

  it('never returns an empty suggestion list', () => {
    for (const scope of ['stake', 'CO', 'peterson-branch', 'unknown', '']) {
      expect(callingsForScope(scope, CATALOGUE).length).toBeGreaterThan(0);
    }
  });
});
