// Pure unit tests for the roster / All Seats sort logic.
//
// Sort is derived from the seat's callings (auto) / reason (manual)
// against the compiled churchwide `calling → order` table
// (@kindoo/shared), NOT the denormalised `seat.sort_order` (which the
// comparator ignores). Manual seats carry `callings: []` and store the
// calling in free-text `seat.reason` (spec §13) — so the manual band
// matches `seat.reason`, the auto band matches `seat.callings` (MIN).
// temp keeps its expiry-descending order. See
// `extension/docs/sync-design.md` Stage 1(a).

import type { TimestampLike } from '@kindoo/shared';
import { describe, expect, it } from 'vitest';
import { makeSeat } from '../../../test/fixtures';
import { sortSeatsAcrossScopes, sortSeatsWithinScope } from './seats';

/** Build a structural `TimestampLike` at a given ISO instant. */
function ts(iso: string): TimestampLike {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

describe('sortSeatsWithinScope', () => {
  it('orders type bands as auto, manual, temp', () => {
    const a = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'A',
      type: 'temp',
      callings: [],
      end_date: '2026-12-31',
    });
    const b = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'B',
      type: 'manual',
      callings: [],
      reason: 'Bishop',
    });
    const c = makeSeat({
      member_canonical: 'c@x.com',
      member_email: 'c@x.com',
      member_name: 'C',
      type: 'auto',
      callings: ['Bishop'],
    });
    const sorted = sortSeatsWithinScope([a, b, c]);
    expect(sorted.map((s) => s.member_name)).toEqual(['C', 'B', 'A']);
  });

  it('within auto, sorts by calling order ascending (not sort_order)', () => {
    // sort_order is set to the INVERSE of the calling order to prove
    // it is ignored: if the comparator still read sort_order, the
    // result would flip.
    const stakePres = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'Stake Pres',
      type: 'auto',
      callings: ['Stake President'], // order 0
      sort_order: 999,
    });
    const bishop = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Bishop',
      type: 'auto',
      callings: ['Bishop'], // order 31
      sort_order: 500,
    });
    const eqPres = makeSeat({
      member_canonical: 'c@x.com',
      member_email: 'c@x.com',
      member_name: 'EQ Pres',
      type: 'auto',
      callings: ['Elders Quorum President'], // order 41
      sort_order: 0,
    });
    const sorted = sortSeatsWithinScope([eqPres, bishop, stakePres]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Stake Pres', 'Bishop', 'EQ Pres']);
  });

  it('within manual, sorts by reason→calling order (production shape: callings [], reason set)', () => {
    // Manual seats carry callings: [] and store the calling in reason.
    // Names are deliberately reverse-alpha to the calling order: a name
    // sort would yield ['Aaron', 'Zach']; the reason-calling sort must
    // put the Bishop (Zach) first.
    const eqPres = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'Aaron',
      type: 'manual',
      callings: [],
      reason: 'Elders Quorum President', // order 41
    });
    const bishop = makeSeat({
      member_canonical: 'z@x.com',
      member_email: 'z@x.com',
      member_name: 'Zach',
      type: 'manual',
      callings: [],
      reason: 'Bishop', // order 31
    });
    const sorted = sortSeatsWithinScope([eqPres, bishop]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Zach', 'Aaron']);
  });

  it('manual band ignores seat.callings; only seat.reason drives order', () => {
    // Regression for the masked bug: a manual seat's `callings` is []
    // in production, so reading callings sorts every manual seat as
    // "unknown". Even if callings were somehow populated, the manual
    // band must key on reason. Here callings is deliberately mismatched
    // to reason to prove reason wins.
    const a = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'Reason Bishop',
      type: 'manual',
      callings: ['Primary Secretary'], // would be order 65 if read
      reason: 'Bishop', // order 31 — this must win
      created_at: ts('2026-05-10T00:00:00Z'),
    });
    const b = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Reason EQ Pres',
      type: 'manual',
      callings: ['Bishop'], // would be order 31 if read
      reason: 'Elders Quorum President', // order 41
      created_at: ts('2026-05-01T00:00:00Z'),
    });
    const sorted = sortSeatsWithinScope([b, a]);
    // By reason: Bishop (31) < EQ Pres (41). If callings were read, the
    // order would flip (b's callings=Bishop would lead).
    expect(sorted.map((s) => s.member_name)).toEqual(['Reason Bishop', 'Reason EQ Pres']);
  });

  it('a manual seat with no reason / empty reason is unknown → band bottom by created_at asc', () => {
    const namedBishop = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Has Reason',
      type: 'manual',
      callings: [],
      reason: 'Bishop', // order 31
      created_at: ts('2026-05-20T00:00:00Z'),
    });
    const noReasonNewer = makeSeat({
      member_canonical: 'n@x.com',
      member_email: 'n@x.com',
      member_name: 'No Reason Newer',
      type: 'manual',
      callings: [],
      // reason absent → unknown
      created_at: ts('2026-05-15T00:00:00Z'),
    });
    const noReasonOlder = makeSeat({
      member_canonical: 'o@x.com',
      member_email: 'o@x.com',
      member_name: 'No Reason Older',
      type: 'manual',
      callings: [],
      reason: '', // empty → unknown
      created_at: ts('2026-05-02T00:00:00Z'),
    });
    const sorted = sortSeatsWithinScope([noReasonNewer, namedBishop, noReasonOlder]);
    expect(sorted.map((s) => s.member_name)).toEqual([
      'Has Reason',
      'No Reason Older',
      'No Reason Newer',
    ]);
  });

  it('manual band matches reason case-insensitively / with surrounding whitespace', () => {
    const messy = makeSeat({
      member_canonical: 'm@x.com',
      member_email: 'm@x.com',
      member_name: 'Messy Bishop',
      type: 'manual',
      callings: [],
      reason: '  bIsHoP ', // normalises to Bishop (order 31)
    });
    const eqPres = makeSeat({
      member_canonical: 'e@x.com',
      member_email: 'e@x.com',
      member_name: 'EQ Pres',
      type: 'manual',
      callings: [],
      reason: 'Elders Quorum President', // 41
    });
    const sorted = sortSeatsWithinScope([eqPres, messy]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Messy Bishop', 'EQ Pres']);
  });

  it('auto + manual each calling-order their own band (auto via callings, manual via reason)', () => {
    const autoBishop = makeSeat({
      member_canonical: 'ab@x.com',
      member_email: 'ab@x.com',
      member_name: 'Auto Bishop',
      type: 'auto',
      callings: ['Bishop'], // 31
    });
    const autoEq = makeSeat({
      member_canonical: 'ae@x.com',
      member_email: 'ae@x.com',
      member_name: 'Auto EQ',
      type: 'auto',
      callings: ['Elders Quorum President'], // 41
    });
    const manualBishop = makeSeat({
      member_canonical: 'mb@x.com',
      member_email: 'mb@x.com',
      member_name: 'Manual Bishop',
      type: 'manual',
      callings: [],
      reason: 'Bishop', // 31
    });
    const manualEq = makeSeat({
      member_canonical: 'me@x.com',
      member_email: 'me@x.com',
      member_name: 'Manual EQ',
      type: 'manual',
      callings: [],
      reason: 'Elders Quorum President', // 41
    });
    const sorted = sortSeatsWithinScope([manualEq, autoEq, manualBishop, autoBishop]);
    expect(sorted.map((s) => s.member_name)).toEqual([
      'Auto Bishop',
      'Auto EQ',
      'Manual Bishop',
      'Manual EQ',
    ]);
  });

  it('uses the MIN calling order for a multi-calling auto seat', () => {
    // Seat A holds EQ Pres (41) + Bishop (31) → effective order 31.
    // Seat B holds only Bishopric First Counselor (33). A wins.
    const multi = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'Multi',
      type: 'auto',
      callings: ['Elders Quorum President', 'Bishop'], // MIN = 31
    });
    const single = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Single',
      type: 'auto',
      callings: ['Bishopric First Counselor'], // 33
    });
    const sorted = sortSeatsWithinScope([single, multi]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Multi', 'Single']);
  });

  it('unknown-calling auto seats sort to the bottom of the band, then by created_at ascending', () => {
    const bishop = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Bishop',
      type: 'auto',
      callings: ['Bishop'], // known → ahead of unknowns
      created_at: ts('2026-05-01T00:00:00Z'),
    });
    const unknownNewer = makeSeat({
      member_canonical: 'n@x.com',
      member_email: 'n@x.com',
      member_name: 'Unknown Newer',
      type: 'auto',
      callings: ['Sunbeam Teacher'], // not in table → unknown
      created_at: ts('2026-05-20T00:00:00Z'),
    });
    const unknownOlder = makeSeat({
      member_canonical: 'o@x.com',
      member_email: 'o@x.com',
      member_name: 'Unknown Older',
      type: 'auto',
      callings: ['Accompanist'], // not in table → unknown
      created_at: ts('2026-05-02T00:00:00Z'),
    });
    const sorted = sortSeatsWithinScope([unknownNewer, bishop, unknownOlder]);
    // Known calling first; then unknowns oldest-created first.
    expect(sorted.map((s) => s.member_name)).toEqual(['Bishop', 'Unknown Older', 'Unknown Newer']);
  });

  it('an auto seat with no callings is treated as unknown (band bottom)', () => {
    const bishop = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Bishop',
      type: 'auto',
      callings: ['Bishop'],
    });
    const noCallings = makeSeat({
      member_canonical: 'n@x.com',
      member_email: 'n@x.com',
      member_name: 'No Callings',
      type: 'auto',
      callings: [],
    });
    const sorted = sortSeatsWithinScope([noCallings, bishop]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Bishop', 'No Callings']);
  });

  it('among unknown auto seats, missing created_at sorts to the very bottom', () => {
    const unknownDated = makeSeat({
      member_canonical: 'd@x.com',
      member_email: 'd@x.com',
      member_name: 'Unknown Dated',
      type: 'auto',
      callings: ['Accompanist'],
      created_at: ts('2026-05-10T00:00:00Z'),
    });
    const unknownUndated = makeSeat({
      member_canonical: 'u@x.com',
      member_email: 'u@x.com',
      member_name: 'Unknown Undated',
      type: 'auto',
      callings: ['Accompanist'],
      // created_at deliberately mangled to an undefined-bearing value
      // to exercise the defensive guard.
      created_at: undefined as unknown as TimestampLike,
    });
    const sorted = sortSeatsWithinScope([unknownUndated, unknownDated]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Unknown Dated', 'Unknown Undated']);
  });

  it('breaks an equal-calling-order tie by created_at ascending then name', () => {
    // Both Bishop (same order); older created_at wins; equal created_at
    // falls through to name.
    const newer = makeSeat({
      member_canonical: 'n@x.com',
      member_email: 'n@x.com',
      member_name: 'Newer Bishop',
      type: 'auto',
      callings: ['Bishop'],
      created_at: ts('2026-05-15T00:00:00Z'),
    });
    const older = makeSeat({
      member_canonical: 'o@x.com',
      member_email: 'o@x.com',
      member_name: 'Older Bishop',
      type: 'auto',
      callings: ['Bishop'],
      created_at: ts('2026-05-01T00:00:00Z'),
    });
    const sorted = sortSeatsWithinScope([newer, older]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Older Bishop', 'Newer Bishop']);
  });

  it('within temp, sorts by end_date descending (soonest-expiring at the bottom)', () => {
    const earlier = makeSeat({
      member_canonical: 'e@x.com',
      member_email: 'e@x.com',
      member_name: 'Earlier',
      type: 'temp',
      callings: [],
      end_date: '2026-05-01',
    });
    const later = makeSeat({
      member_canonical: 'l@x.com',
      member_email: 'l@x.com',
      member_name: 'Later',
      type: 'temp',
      callings: [],
      end_date: '2026-12-31',
    });
    const sorted = sortSeatsWithinScope([earlier, later]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Later', 'Earlier']);
  });

  it('within temp, calling order does NOT apply (reason / callings ignored for temp)', () => {
    // Even if a temp carried a calling-table name in reason, the temp
    // band sorts by expiry, not calling order. Later-expiring leads.
    const soonNamed = makeSeat({
      member_canonical: 's@x.com',
      member_email: 's@x.com',
      member_name: 'Soon Expiring',
      type: 'temp',
      callings: [],
      reason: 'Bishop', // order 31 — must be ignored for temp
      end_date: '2026-05-01',
    });
    const lateUnknown = makeSeat({
      member_canonical: 'l@x.com',
      member_email: 'l@x.com',
      member_name: 'Late Expiring',
      type: 'temp',
      callings: [],
      reason: 'Covering nursery',
      end_date: '2026-12-31',
    });
    const sorted = sortSeatsWithinScope([soonNamed, lateUnknown]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Late Expiring', 'Soon Expiring']);
  });

  it('within temp, missing end_date sorts last', () => {
    const dated = makeSeat({
      member_canonical: 'd@x.com',
      member_email: 'd@x.com',
      member_name: 'Dated',
      type: 'temp',
      callings: [],
      end_date: '2026-08-15',
    });
    const undated = makeSeat({
      member_canonical: 'u@x.com',
      member_email: 'u@x.com',
      member_name: 'Undated',
      type: 'temp',
      callings: [],
    });
    const sorted = sortSeatsWithinScope([undated, dated]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Dated', 'Undated']);
  });
});

describe('sortSeatsAcrossScopes', () => {
  it('puts stake-scope ahead of ward-scope, then wards alpha by ward_code', () => {
    const co = makeSeat({
      member_canonical: 'co@x.com',
      member_email: 'co@x.com',
      member_name: 'CO Bishop',
      scope: 'CO',
      type: 'auto',
      callings: ['Bishop'],
    });
    const ge = makeSeat({
      member_canonical: 'ge@x.com',
      member_email: 'ge@x.com',
      member_name: 'GE Bishop',
      scope: 'GE',
      type: 'auto',
      callings: ['Bishop'],
    });
    const stake = makeSeat({
      member_canonical: 'st@x.com',
      member_email: 'st@x.com',
      member_name: 'Stake Pres',
      scope: 'stake',
      type: 'auto',
      callings: ['Stake President'],
    });
    const sorted = sortSeatsAcrossScopes([ge, co, stake]);
    expect(sorted.map((s) => `${s.scope}:${s.member_name}`)).toEqual([
      'stake:Stake Pres',
      'CO:CO Bishop',
      'GE:GE Bishop',
    ]);
  });

  it('keeps scope-primary ordering even when a ward seat outranks the stake seat by calling', () => {
    // A stake Technology Specialist (order 30) outranks a ward Bishop
    // (order 31) on calling, but scope-primary must still place the
    // stake row first regardless of the per-band calling order.
    const wardBishop = makeSeat({
      member_canonical: 'w@x.com',
      member_email: 'w@x.com',
      member_name: 'Ward Bishop',
      scope: 'CO',
      type: 'auto',
      callings: ['Bishop'], // order 31
    });
    const stakeLowPriority = makeSeat({
      member_canonical: 's@x.com',
      member_email: 's@x.com',
      member_name: 'Stake Tech',
      scope: 'stake',
      type: 'auto',
      callings: ['Stake Technology Specialist'], // order 30
    });
    const sorted = sortSeatsAcrossScopes([wardBishop, stakeLowPriority]);
    expect(sorted.map((s) => s.scope)).toEqual(['stake', 'CO']);
  });

  it('within a scope, applies the type-banded calling-order sort (auto via callings, manual via reason)', () => {
    const stakeAutoLow = makeSeat({
      member_canonical: 'sa@x.com',
      member_email: 'sa@x.com',
      member_name: 'Stake Auto YM',
      scope: 'stake',
      type: 'auto',
      callings: ['Stake Young Men President'], // order 14
    });
    const stakeAutoHigh = makeSeat({
      member_canonical: 'sh@x.com',
      member_email: 'sh@x.com',
      member_name: 'Stake Auto Pres',
      scope: 'stake',
      type: 'auto',
      callings: ['Stake President'], // order 0
    });
    const stakeManual = makeSeat({
      member_canonical: 'sm@x.com',
      member_email: 'sm@x.com',
      member_name: 'Stake Manual',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Stake Clerk', // order 3
    });
    const coAuto = makeSeat({
      member_canonical: 'ca@x.com',
      member_email: 'ca@x.com',
      member_name: 'CO Auto',
      scope: 'CO',
      type: 'auto',
      callings: ['Bishop'],
    });
    const sorted = sortSeatsAcrossScopes([coAuto, stakeManual, stakeAutoLow, stakeAutoHigh]);
    expect(sorted.map((s) => `${s.scope}:${s.member_name}`)).toEqual([
      'stake:Stake Auto Pres',
      'stake:Stake Auto YM',
      'stake:Stake Manual',
      'CO:CO Auto',
    ]);
  });
});
