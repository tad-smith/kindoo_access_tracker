// Tests for the compiled `calling → order` table. Pins the canonical
// priorities at the band boundaries (stake head / tail, ward head /
// tail), the trim + case-insensitive matching, the unknown → null
// contract, and the seat-level MIN aggregation.

import { describe, expect, it } from 'vitest';
import { callingSortOrder, seatCallingOrder } from './callingSortOrder.js';

describe('callingSortOrder', () => {
  it('maps a known calling to its priority index (0-based)', () => {
    // First entry → 0, per the canonical order in the design spec
    // (printed as 1-indexed; the table is 0-indexed internally).
    expect(callingSortOrder('Stake President')).toBe(0);
  });

  it('maps the stake-band tail and ward-band head across the boundary', () => {
    // 'Patriarch' is the 42nd entry (index 41) — the stake-band tail;
    // 'Bishop' is the 43rd (index 42) — the ward-band head.
    expect(callingSortOrder('Patriarch')).toBe(41);
    expect(callingSortOrder('Bishop')).toBe(42);
  });

  it('maps the final ward calling to the last index (84)', () => {
    expect(callingSortOrder('Technology Specialist')).toBe(84);
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
    expect(callingSortOrder('Valiant Activities Leader')).toBe(76);
    expect(callingSortOrder('Building Representative')).toBe(81);
  });

  it('orders Bishop ahead of Elders Quorum President ahead of Primary President', () => {
    const bishop = callingSortOrder('Bishop')!;
    const eqPres = callingSortOrder('Elders Quorum President')!;
    const primaryPres = callingSortOrder('Primary President')!;
    expect(bishop).toBeLessThan(eqPres);
    expect(eqPres).toBeLessThan(primaryPres);
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
    expect(callingSortOrder('Ward Assistant Clerk--Finance')).toBe(50);
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
    // Bishop (42) wins over Primary President (72).
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
