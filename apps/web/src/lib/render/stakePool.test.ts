import { describe, expect, it } from 'vitest';
import type { Ward } from '@kindoo/shared';
import { stakeAvailablePoolSize } from './stakePool';

function ward(overrides: Partial<Ward> = {}): Ward {
  return {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Main',
    seat_cap: 20,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Ward;
}

describe('stakeAvailablePoolSize', () => {
  it('subtracts the sum of every ward seat_cap from the stake cap', () => {
    expect(
      stakeAvailablePoolSize(200, [
        ward({ ward_code: 'CO', seat_cap: 50 }),
        ward({ ward_code: 'GE', seat_cap: 50 }),
        ward({ ward_code: 'PR', seat_cap: 50 }),
      ]),
    ).toBe(50);
  });

  it('returns the full stake_seat_cap when there are no wards', () => {
    expect(stakeAvailablePoolSize(200, [])).toBe(200);
  });

  it('treats a ward with an unset seat_cap as 0 (does not poison the sum)', () => {
    expect(
      stakeAvailablePoolSize(200, [
        ward({ ward_code: 'CO', seat_cap: 50 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ward({ ward_code: 'GE', seat_cap: undefined as any }),
      ]),
    ).toBe(150);
  });

  it('returns null when stake_seat_cap is unset', () => {
    expect(stakeAvailablePoolSize(undefined, [ward({ seat_cap: 20 })])).toBeNull();
    expect(stakeAvailablePoolSize(null, [ward({ seat_cap: 20 })])).toBeNull();
  });

  it('returns a negative value when ward caps exceed the stake cap (misconfiguration)', () => {
    // UtilizationBar handles cap <= 0 as the "(cap unset)" variant, so
    // the helper passes the negative through rather than clamping.
    expect(
      stakeAvailablePoolSize(100, [
        ward({ ward_code: 'CO', seat_cap: 60 }),
        ward({ ward_code: 'GE', seat_cap: 60 }),
      ]),
    ).toBe(-20);
  });
});
