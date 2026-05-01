// Pure unit tests for the roster / All Seats sort logic.

import { describe, expect, it } from 'vitest';
import { makeSeat } from '../../../test/fixtures';
import { sortSeatsAcrossScopes, sortSeatsWithinScope } from './seats';

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
    });
    const c = makeSeat({
      member_canonical: 'c@x.com',
      member_email: 'c@x.com',
      member_name: 'C',
      type: 'auto',
      sort_order: 5,
    });
    const sorted = sortSeatsWithinScope([a, b, c]);
    expect(sorted.map((s) => s.member_name)).toEqual(['C', 'B', 'A']);
  });

  it('within auto, sorts by sort_order ascending', () => {
    const a = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'A',
      type: 'auto',
      sort_order: 30,
    });
    const b = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'B',
      type: 'auto',
      sort_order: 10,
    });
    const c = makeSeat({
      member_canonical: 'c@x.com',
      member_email: 'c@x.com',
      member_name: 'C',
      type: 'auto',
      sort_order: 20,
    });
    const sorted = sortSeatsWithinScope([a, b, c]);
    expect(sorted.map((s) => s.member_name)).toEqual(['B', 'C', 'A']);
  });

  it('auto: null sort_order sorts to the bottom of the auto band', () => {
    const numbered = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'Numbered',
      type: 'auto',
      sort_order: 99,
    });
    const orphanA = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Orphan A',
      type: 'auto',
      sort_order: null,
    });
    const orphanB = makeSeat({
      member_canonical: 'c@x.com',
      member_email: 'c@x.com',
      member_name: 'Orphan Z',
      type: 'auto',
      // sort_order omitted entirely — equivalent to null.
    });
    const manual = makeSeat({
      member_canonical: 'd@x.com',
      member_email: 'd@x.com',
      member_name: 'Manual',
      type: 'manual',
      callings: [],
    });
    const sorted = sortSeatsWithinScope([orphanB, manual, numbered, orphanA]);
    expect(sorted.map((s) => s.member_name)).toEqual([
      'Numbered',
      'Orphan A',
      'Orphan Z',
      'Manual',
    ]);
  });

  it('within manual, sorts alpha by member_name (case-insensitive)', () => {
    const a = makeSeat({
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'zenith',
      type: 'manual',
      callings: [],
    });
    const b = makeSeat({
      member_canonical: 'b@x.com',
      member_email: 'b@x.com',
      member_name: 'Apple',
      type: 'manual',
      callings: [],
    });
    const sorted = sortSeatsWithinScope([a, b]);
    expect(sorted.map((s) => s.member_name)).toEqual(['Apple', 'zenith']);
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
      sort_order: 1,
    });
    const ge = makeSeat({
      member_canonical: 'ge@x.com',
      member_email: 'ge@x.com',
      member_name: 'GE Bishop',
      scope: 'GE',
      type: 'auto',
      sort_order: 1,
    });
    const stake = makeSeat({
      member_canonical: 'st@x.com',
      member_email: 'st@x.com',
      member_name: 'Stake Pres',
      scope: 'stake',
      type: 'auto',
      sort_order: 1,
    });
    const sorted = sortSeatsAcrossScopes([ge, co, stake]);
    expect(sorted.map((s) => `${s.scope}:${s.member_name}`)).toEqual([
      'stake:Stake Pres',
      'CO:CO Bishop',
      'GE:GE Bishop',
    ]);
  });

  it('within a scope, applies the same type-banded sort as within-scope', () => {
    const stakeAuto = makeSeat({
      member_canonical: 'sa@x.com',
      member_email: 'sa@x.com',
      member_name: 'Stake Auto',
      scope: 'stake',
      type: 'auto',
      sort_order: 1,
    });
    const stakeManual = makeSeat({
      member_canonical: 'sm@x.com',
      member_email: 'sm@x.com',
      member_name: 'Stake Manual',
      scope: 'stake',
      type: 'manual',
      callings: [],
    });
    const coAuto = makeSeat({
      member_canonical: 'ca@x.com',
      member_email: 'ca@x.com',
      member_name: 'CO Auto',
      scope: 'CO',
      type: 'auto',
      sort_order: 1,
    });
    const sorted = sortSeatsAcrossScopes([coAuto, stakeManual, stakeAuto]);
    expect(sorted.map((s) => `${s.scope}:${s.type}`)).toEqual([
      'stake:auto',
      'stake:manual',
      'CO:auto',
    ]);
  });
});
