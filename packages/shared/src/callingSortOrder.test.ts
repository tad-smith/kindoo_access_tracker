// Tests for the compiled `calling → order` table. Pins the canonical
// priorities at the band boundaries (stake head / tail, unit head /
// tail), the ward↔branch interleaving, the trim + case-insensitive
// matching, the unknown → null contract, and the seat-level MIN
// aggregation.

import { describe, expect, it } from 'vitest';
import { callingSortOrder, seatCallingOrder } from './callingSortOrder.js';

describe('callingSortOrder', () => {
  it('maps a known calling to its priority index (0-based)', () => {
    // First entry → 0, per the canonical order in the design spec
    // (printed as 1-indexed; the table is 0-indexed internally).
    expect(callingSortOrder('Stake President')).toBe(0);
  });

  it('maps the stake-band tail and unit-band head across the boundary', () => {
    // 'Patriarch' is the 42nd entry (index 41) — the stake-band tail;
    // 'Bishop' is the 43rd (index 42) — the unit-band head.
    expect(callingSortOrder('Patriarch')).toBe(41);
    expect(callingSortOrder('Bishop')).toBe(42);
  });

  it('maps the final unit calling to the last index (91)', () => {
    expect(callingSortOrder('Technology Specialist')).toBe(91);
  });

  it('places the operator-added stake callings in order', () => {
    // New 85-entry stake-band additions (unprefixed spellings used
    // verbatim per the operator's authoritative list).
    expect(callingSortOrder('Stake Building Representative')).toBe(30);
    expect(callingSortOrder('Stake Technology Specialist')).toBe(32);
    expect(callingSortOrder('Stake Young Single Adult Advisor')).toBe(35);
    expect(callingSortOrder('Audit Committee Chairman')).toBe(38);
    expect(callingSortOrder('Audit Committee Member')).toBe(39);
    expect(callingSortOrder('Auditor')).toBe(40);
  });

  it('places the operator-added ward callings in order', () => {
    expect(callingSortOrder('Valiant Activities Leader')).toBe(83);
    expect(callingSortOrder('Building Representative')).toBe(88);
  });

  it('orders Bishop ahead of Elders Quorum President ahead of Primary President', () => {
    const bishop = callingSortOrder('Bishop')!;
    const eqPres = callingSortOrder('Elders Quorum President')!;
    const primaryPres = callingSortOrder('Primary President')!;
    expect(bishop).toBeLessThan(eqPres);
    expect(eqPres).toBeLessThan(primaryPres);
  });

  it('ranks every branch calling rather than returning null', () => {
    for (const name of [
      'Branch President',
      'Branch Presidency First Counselor',
      'Branch Presidency Second Counselor',
      'Branch Clerk',
      'Branch Assistant Clerk',
      'Branch Assistant Clerk--Membership',
      'Branch Assistant Clerk--Finance',
    ]) {
      expect(callingSortOrder(name)).not.toBeNull();
    }
  });

  it('places each branch calling immediately after its ward counterpart', () => {
    const pairs: readonly [string, string][] = [
      ['Bishop', 'Branch President'],
      ['Bishopric First Counselor', 'Branch Presidency First Counselor'],
      ['Bishopric Second Counselor', 'Branch Presidency Second Counselor'],
      ['Ward Clerk', 'Branch Clerk'],
      ['Ward Assistant Clerk', 'Branch Assistant Clerk'],
      ['Ward Assistant Clerk--Membership', 'Branch Assistant Clerk--Membership'],
      ['Ward Assistant Clerk--Finance', 'Branch Assistant Clerk--Finance'],
    ];
    for (const [ward, branch] of pairs) {
      expect(callingSortOrder(branch)).toBe(callingSortOrder(ward)! + 1);
    }
  });

  it('keeps the branch hierarchy in order — president, counselors, clerk', () => {
    const order = [
      'Branch President',
      'Branch Presidency First Counselor',
      'Branch Presidency Second Counselor',
      'Branch Clerk',
      'Branch Assistant Clerk',
    ].map((name) => callingSortOrder(name)!);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]).toBeLessThan(order[i]!);
    }
  });

  it('ranks a Branch President above every shared-family calling', () => {
    // A branch's Elders Quorum / Relief Society / Primary / Young Women
    // people use the same entries a ward's do, and sort below leadership.
    const branchPres = callingSortOrder('Branch President')!;
    for (const name of [
      'Elders Quorum President',
      'Relief Society President',
      'Primary President',
      'Young Women President',
    ]) {
      expect(branchPres).toBeLessThan(callingSortOrder(name)!);
    }
  });

  it('has no Branch Executive Secretary', () => {
    expect(callingSortOrder('Branch Executive Secretary')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(callingSortOrder('bishop')).toBe(callingSortOrder('Bishop'));
    expect(callingSortOrder('ELDERS QUORUM PRESIDENT')).toBe(
      callingSortOrder('Elders Quorum President'),
    );
  });

  it('matches after trimming surrounding whitespace', () => {
    expect(callingSortOrder('  Bishop  ')).toBe(callingSortOrder('Bishop'));
    expect(callingSortOrder('\tStake President\n')).toBe(callingSortOrder('Stake President'));
  });

  it('matches a mixed case + whitespace variant to the canonical index', () => {
    expect(callingSortOrder('  bIsHoP ')).toBe(42);
  });

  it('preserves the double-hyphen calling names verbatim', () => {
    expect(callingSortOrder('Stake Assistant Clerk--Membership')).toBe(7);
    expect(callingSortOrder('Ward Assistant Clerk--Finance')).toBe(56);
    expect(callingSortOrder('Branch Assistant Clerk--Membership')).toBe(55);
    expect(callingSortOrder('Branch Assistant Clerk--Finance')).toBe(57);
  });

  it('returns null for a calling not in the table', () => {
    expect(callingSortOrder('Sunbeam Teacher')).toBeNull();
    expect(callingSortOrder('Accompanist')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(callingSortOrder('')).toBeNull();
    expect(callingSortOrder('   ')).toBeNull();
  });

  it('does NOT match on a substring or wildcard (exact only)', () => {
    // 'Counselor *' wildcard-style and partial names must not match.
    expect(callingSortOrder('Counselor')).toBeNull();
    expect(callingSortOrder('First Counselor')).toBeNull();
    expect(callingSortOrder('Bishopric')).toBeNull();
  });
});

describe('seatCallingOrder', () => {
  it('returns the single calling order for a one-calling seat', () => {
    expect(seatCallingOrder(['Bishop'])).toBe(callingSortOrder('Bishop'));
  });

  it('returns the MIN order across multiple callings', () => {
    // Bishop (42) wins over Primary President (79).
    expect(seatCallingOrder(['Primary President', 'Bishop'])).toBe(callingSortOrder('Bishop'));
  });

  it('order is independent of the callings array order', () => {
    expect(seatCallingOrder(['Bishop', 'Primary President'])).toBe(
      seatCallingOrder(['Primary President', 'Bishop']),
    );
  });

  it('ignores unknown callings when at least one matches', () => {
    // 'Accompanist' is unknown; the matched 'Elders Quorum Secretary'
    // drives the order.
    expect(seatCallingOrder(['Accompanist', 'Elders Quorum Secretary'])).toBe(
      callingSortOrder('Elders Quorum Secretary'),
    );
  });

  it('applies trim + case-insensitive matching to each calling', () => {
    expect(seatCallingOrder(['  primary president ', 'BISHOP'])).toBe(callingSortOrder('Bishop'));
  });

  it('returns null for an empty callings array', () => {
    expect(seatCallingOrder([])).toBeNull();
  });

  it('returns null when every calling is unknown', () => {
    expect(seatCallingOrder(['Accompanist', 'Sunbeam Teacher'])).toBeNull();
  });
});
