import { describe, expect, it } from 'vitest';
import { computeOverCaps } from './overCaps.js';
import type { DuplicateGrant, Seat, Ward } from '@kindoo/shared';

const seat = (overrides: Partial<Seat> = {}): Seat =>
  ({
    member_canonical: 'a@gmail.com',
    member_email: 'a@gmail.com',
    member_name: 'A',
    scope: 'CO',
    type: 'auto',
    callings: ['Bishop'],
    building_names: ['Maple Building'],
    duplicate_grants: [],
    ...overrides,
  }) as Seat;

const ward = (overrides: Partial<Ward> = {}): Ward =>
  ({
    ward_code: 'CO',
    ward_name: 'Maple',
    building_name: 'Maple Building',
    seat_cap: 20,
    ...overrides,
  }) as Ward;

/** `ward_code → kindoo_site_id`. Wards omitted here classify as home. */
const sites = (entries: Record<string, string | null> = {}): Map<string, string | null> =>
  new Map(Object.entries(entries));

/** A `duplicate_grants[]` entry. */
const dup = (overrides: Partial<DuplicateGrant> = {}): DuplicateGrant =>
  ({
    scope: 'stake',
    type: 'auto',
    kindoo_site_id: null,
    detected_at: 0,
    ...overrides,
  }) as DuplicateGrant;

/** A parallel-site (home) stake grant entry for `duplicate_grants[]`. */
const stakeDup = (overrides: Partial<DuplicateGrant> = {}): DuplicateGrant =>
  dup({ scope: 'stake', type: 'manual', kindoo_site_id: null, ...overrides });

describe('computeOverCaps', () => {
  it('returns empty when nothing is over', () => {
    expect(
      computeOverCaps({
        seats: [seat({ member_canonical: 'a' }), seat({ member_canonical: 'b' })],
        wards: [ward({ ward_code: 'CO', seat_cap: 20 })],
        stakeSeatCap: 100,
        wardSites: sites(),
      }),
    ).toEqual([]);
  });

  it('flags a ward whose count exceeds its cap', () => {
    const seats = Array.from({ length: 21 }, (_, i) => seat({ member_canonical: `m${i}` }));
    const wards = [ward({ ward_code: 'CO', seat_cap: 20 })];
    expect(computeOverCaps({ seats, wards, stakeSeatCap: 100, wardSites: sites() })).toEqual([
      { pool: 'CO', count: 21, cap: 20, over_by: 1 },
    ]);
  });

  it('skips wards with cap=0 (interpreted as "no cap configured")', () => {
    const seats = [seat({ member_canonical: 'a' })];
    const wards = [ward({ ward_code: 'CO', seat_cap: 0 })];
    expect(computeOverCaps({ seats, wards, stakeSeatCap: 0, wardSites: sites() })).toEqual([]);
  });

  it('stake portion-cap = stake_seat_cap - ward seats; over fires when stake-scope exceeds', () => {
    // 200 license total; 195 ward seats; portion cap = 5; stake-scope = 10 → over by 5.
    const seats = [
      ...Array.from({ length: 195 }, (_, i) => seat({ member_canonical: `m${i}`, scope: 'CO' })),
      ...Array.from({ length: 10 }, (_, i) => seat({ member_canonical: `s${i}`, scope: 'stake' })),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 250 })];
    const out = computeOverCaps({ seats, wards, stakeSeatCap: 200, wardSites: sites() });
    expect(out).toContainEqual({ pool: 'stake', count: 10, cap: 5, over_by: 5 });
  });

  it('stake portion-cap clamped at 0', () => {
    // ward seats already exceed stake_seat_cap; portion=0; any stake-scope is over.
    const seats = [
      ...Array.from({ length: 50 }, (_, i) => seat({ member_canonical: `m${i}`, scope: 'CO' })),
      seat({ member_canonical: 's', scope: 'stake' }),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 100 })];
    const out = computeOverCaps({ seats, wards, stakeSeatCap: 20, wardSites: sites() });
    expect(out).toContainEqual({ pool: 'stake', count: 1, cap: 0, over_by: 1 });
  });

  it('foreign-site ward seats do not subtract from home stake portion', () => {
    // 5 stake-scope + 5 foreign-ward seats. Home portion should ignore
    // the foreign-ward seats; portion-cap = stakeSeatCap - 0 = 20; the
    // 5 stake-scope seats are under it.
    const seats = [
      ...Array.from({ length: 5 }, (_, i) => seat({ member_canonical: `s${i}`, scope: 'stake' })),
      ...Array.from({ length: 5 }, (_, i) => seat({ member_canonical: `f${i}`, scope: 'FN' })),
    ];
    const wards = [ward({ ward_code: 'FN', seat_cap: 50 })];
    expect(
      computeOverCaps({ seats, wards, stakeSeatCap: 20, wardSites: sites({ FN: 'east-stake' }) }),
    ).toEqual([]);
  });

  it('mixes home and foreign ward seats: only home seats shrink the stake portion', () => {
    // 5 home-ward seats + 5 foreign-ward seats + 16 stake-scope seats;
    // stakeSeatCap = 20. Home portion = 20 - 5 = 15; stake-scope (16) >
    // 15 → over by 1. Foreign-ward seats excluded from both numerator
    // and denominator of the home stake calc.
    const seats = [
      ...Array.from({ length: 5 }, (_, i) => seat({ member_canonical: `h${i}`, scope: 'CO' })),
      ...Array.from({ length: 5 }, (_, i) => seat({ member_canonical: `f${i}`, scope: 'FN' })),
      ...Array.from({ length: 16 }, (_, i) => seat({ member_canonical: `s${i}`, scope: 'stake' })),
    ];
    const wards = [
      ward({ ward_code: 'CO', seat_cap: 50 }),
      ward({ ward_code: 'FN', seat_cap: 50 }),
    ];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 20,
      wardSites: sites({ CO: null, FN: 'east-stake' }),
    });
    expect(out).toContainEqual({ pool: 'stake', count: 16, cap: 15, over_by: 1 });
  });

  it('per-ward over-cap still fires for a foreign-site ward (per-ward math unchanged)', () => {
    // Foreign ward FN with seat_cap=2 and 3 seats → over by 1. Each
    // ward's seat_cap is what its own Kindoo site allotted it; the bar
    // reflects that regardless of site assignment.
    const seats = Array.from({ length: 3 }, (_, i) =>
      seat({ member_canonical: `f${i}`, scope: 'FN' }),
    );
    const wards = [ward({ ward_code: 'FN', seat_cap: 2 })];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 100,
      wardSites: sites({ FN: 'east-stake' }),
    });
    expect(out).toContainEqual({ pool: 'FN', count: 3, cap: 2, over_by: 1 });
  });

  it('treats a ward absent from wardSites as home (back-compat with un-mapped wards)', () => {
    // A ward whose building site doesn't resolve counts as home. 5 ward
    // seats reduce the portion-cap to 15; 16 stake-scope → over by 1.
    const seats = [
      ...Array.from({ length: 5 }, (_, i) => seat({ member_canonical: `h${i}`, scope: 'CO' })),
      ...Array.from({ length: 16 }, (_, i) => seat({ member_canonical: `s${i}`, scope: 'stake' })),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 50 })];
    const out = computeOverCaps({ seats, wards, stakeSeatCap: 20, wardSites: sites() }); // CO un-mapped
    expect(out).toContainEqual({ pool: 'stake', count: 16, cap: 15, over_by: 1 });
  });

  it('counts a foreign-ward primary with a stake duplicate toward the stake pool', () => {
    // One foreign-ward-primary seat carrying a parallel-site stake grant.
    // Its primary is foreign (excluded from homeWardSeatsN) and isn't
    // 'stake', so before the fix stakeN was 0. The stake duplicate
    // consumes a home license → stakeN = 1. portionCap = 1 → not over.
    const seats = [
      seat({
        member_canonical: 'f@gmail.com',
        scope: 'FN',
        duplicate_grants: [stakeDup()],
      }),
    ];
    const wards = [ward({ ward_code: 'FN', seat_cap: 50 })];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 1,
      wardSites: sites({ FN: 'east-stake' }),
    });
    expect(out).toEqual([]);
    // Drop the home portion to 0: the single parallel-site dup is over by 1.
    const overOut = computeOverCaps({
      seats: [
        ...seats,
        seat({ member_canonical: 'h@gmail.com', scope: 'CO' }), // home ward shrinks portion to 0
      ],
      wards: [...wards, ward({ ward_code: 'CO', seat_cap: 50 })],
      stakeSeatCap: 1,
      wardSites: sites({ FN: 'east-stake', CO: null }),
    });
    expect(overOut).toContainEqual({ pool: 'stake', count: 1, cap: 0, over_by: 1 });
  });

  it('does not double-count a stake-primary seat that also has ward duplicates', () => {
    // Stake-primary already lands in stakeN via primary scope; ward
    // duplicates on it must not bump it again. 1 stake seat, portion = 1
    // → exactly at cap, not over.
    const seats = [
      seat({
        member_canonical: 's@gmail.com',
        scope: 'stake',
        duplicate_grants: [dup({ scope: 'CO', kindoo_site_id: null })],
      }),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 50 })];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 1,
      wardSites: sites({ CO: null }),
    });
    expect(out).toEqual([]);
  });

  it('does not double-count a home-ward primary that also has a stake duplicate', () => {
    // Home-ward-primary is already in homeWardSeatsN; its stake duplicate
    // must not also bump stakeN. 1 home-ward seat (portion = cap - 1 = 0)
    // + 0 stake-scope. If the stake dup leaked into stakeN it would read
    // 1 > 0 and fire a false over-cap. It must NOT.
    const seats = [
      seat({
        member_canonical: 'h@gmail.com',
        scope: 'CO',
        duplicate_grants: [stakeDup()],
      }),
    ];
    const wards = [ward({ ward_code: 'CO', seat_cap: 50 })];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 1,
      wardSites: sites({ CO: null }),
    });
    expect(out).toEqual([]);
  });

  it('parallel-site stake dups push the stake pool over the portion-cap', () => {
    // 5 home-ward seats → portion = 20 - 5 = 15. 10 stake-primary +
    // 6 foreign-ward-primary seats each carrying a stake duplicate.
    // stakeN = 10 + 6 = 16 > 15 → over by 1. Without the fix stakeN
    // would be 10 (the six parallel-site licenses invisible) and no
    // warning would fire.
    const seats = [
      ...Array.from({ length: 5 }, (_, i) => seat({ member_canonical: `h${i}`, scope: 'CO' })),
      ...Array.from({ length: 10 }, (_, i) => seat({ member_canonical: `s${i}`, scope: 'stake' })),
      ...Array.from({ length: 6 }, (_, i) =>
        seat({ member_canonical: `f${i}`, scope: 'FN', duplicate_grants: [stakeDup()] }),
      ),
    ];
    const wards = [
      ward({ ward_code: 'CO', seat_cap: 50 }),
      ward({ ward_code: 'FN', seat_cap: 50 }),
    ];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 20,
      wardSites: sites({ CO: null, FN: 'east-stake' }),
    });
    expect(out).toContainEqual({ pool: 'stake', count: 16, cap: 15, over_by: 1 });
  });

  it('ignores a within-site (non-stake) duplicate on a foreign-ward primary', () => {
    // Foreign-ward-primary with a foreign-ward duplicate (no stake grant)
    // consumes no home license. stakeN stays 0 → no stake over-cap, and
    // the foreign primary stays out of homeWardSeatsN. Confirms the fix
    // keys off scope === 'stake', not "any duplicate present".
    const seats = [
      seat({
        member_canonical: 'f@gmail.com',
        scope: 'FN',
        duplicate_grants: [dup({ scope: 'GN', kindoo_site_id: 'east-stake' })],
      }),
    ];
    const wards = [
      ward({ ward_code: 'FN', seat_cap: 50 }),
      ward({ ward_code: 'GN', seat_cap: 50 }),
    ];
    const out = computeOverCaps({
      seats,
      wards,
      stakeSeatCap: 1,
      wardSites: sites({ FN: 'east-stake', GN: 'east-stake' }),
    });
    expect(out).toEqual([]);
  });
});
