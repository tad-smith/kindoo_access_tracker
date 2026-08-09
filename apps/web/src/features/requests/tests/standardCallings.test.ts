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
import { callingSortOrder } from '@kindoo/shared';
import { STAKE_CALLINGS, UNIT_CALLINGS } from '../standardCallings';

const ALL_CALLINGS = [...STAKE_CALLINGS, ...UNIT_CALLINGS];

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

  it('splits stake from unit callings at the Bishop boundary', () => {
    const lastStake = callingSortOrder(STAKE_CALLINGS[STAKE_CALLINGS.length - 1]!)!;
    const firstUnit = callingSortOrder(UNIT_CALLINGS[0]!)!;
    expect(UNIT_CALLINGS[0]).toBe('Bishop');
    expect(firstUnit).toBe(lastStake + 1);
  });
});
