import { describe, expect, it } from 'vitest';
import { computeOverCaps } from './overCaps.js';
import type { Seat, Ward } from '@kindoo/shared';

const seat = (overrides: Partial<Seat> = {}): Seat =>
  ({
    member_canonical: 'a@gmail.com',
    member_email: 'a@gmail.com',
    member_name: 'A',
    scope: 'CO',
    type: 'auto',
    callings: ['Bishop'],
    building_names: ['Cordera Building'],
    duplicate_grants: [],
    ...overrides,
  }) as Seat;

const ward = (overrides: Partial<Ward> = {}): Ward =>
  ({
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 20,
    ...overrides,
  }) as Ward;

describe('computeOverCaps', () => {
  it('returns empty when nothing is over', () => {
    expect(
      computeOverCaps({
        seats: [seat({ member_canonical: 'a' }), seat({ member_canonical: 'b' })],
        wards: [ward({ ward_code: 'CO', seat_cap: 20 })],
        stakeSeatCap: 100,
      }),
    ).toEqual([]);
  });

  it('flags a ward whose count exceeds its cap', () => {
    const seats = Array.from({ length: 21 }, (_, i) => seat({ member_canonical: `m${i}` }));
    const wards = [ward({ ward_code: 'CO', seat_cap: 20 })];
    expect(computeOverCaps({ seats, wards, stakeSeatCap: 100 })).toEqual([
      { pool: 'CO', count: 21, cap: 20, over_by: 1 },
    ]);
  });

  it('skips wards with cap=0 (interpreted as "no cap configured")', () => {
    const seats = [seat({ member_canonical: 'a' })];
    const wards = [ward({ ward_code: 'CO', seat_cap: 0 })];
    expect(computeOverCaps({ seats, wards, stakeSeatCap: 0 })).toEqual([]);
  });

  it('stake portion-cap = stake_seat_cap - ward seats; over fires when stake-scope exceeds', () => {
    // 200 license total; 195 ward seats; portion cap = 5; stake-scope = 10 → over by 5.
    const seats = [
      ...Array.from({ length: 195 }, (_, i) => seat({ member_canonical: `m${i}`, scope: 'CO' })),
      ...Array.from({ length: 10 }, (_, i) => seat({ member_canonical: `s${i}`, scope: 'stake' })),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 250 })];
    const out = computeOverCaps({ seats, wards, stakeSeatCap: 200 });
    expect(out).toContainEqual({ pool: 'stake', count: 10, cap: 5, over_by: 5 });
  });

  it('stake portion-cap clamped at 0', () => {
    // ward seats already exceed stake_seat_cap; portion=0; any stake-scope is over.
    const seats = [
      ...Array.from({ length: 50 }, (_, i) => seat({ member_canonical: `m${i}`, scope: 'CO' })),
      seat({ member_canonical: 's', scope: 'stake' }),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 100 })];
    const out = computeOverCaps({ seats, wards, stakeSeatCap: 20 });
    expect(out).toContainEqual({ pool: 'stake', count: 1, cap: 0, over_by: 1 });
  });
});
