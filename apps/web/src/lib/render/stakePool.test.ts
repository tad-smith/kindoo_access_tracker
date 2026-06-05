import { describe, expect, it } from 'vitest';
import type { Building, Ward } from '@kindoo/shared';
import { stakeAvailablePoolSize } from './stakePool';

function ward(overrides: Partial<Ward> = {}): Ward {
  return {
    ward_code: 'CO',
    ward_name: 'Maple',
    building_name: 'Main',
    seat_cap: 20,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  } as Ward;
}

function building(name: string, kindoo_site_id?: string | null): Building {
  return {
    building_id: name.toLowerCase(),
    building_name: name,
    address: '',
    ...(kindoo_site_id !== undefined ? { kindoo_site_id } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('stakeAvailablePoolSize', () => {
  it('subtracts the sum of every ward seat_cap from the stake cap', () => {
    expect(
      stakeAvailablePoolSize(
        200,
        [
          ward({ ward_code: 'CO', seat_cap: 50 }),
          ward({ ward_code: 'GE', seat_cap: 50 }),
          ward({ ward_code: 'PR', seat_cap: 50 }),
        ],
        [building('Main')],
      ),
    ).toBe(50);
  });

  it('returns the full stake_seat_cap when there are no wards', () => {
    expect(stakeAvailablePoolSize(200, [], [])).toBe(200);
  });

  it('treats a ward with an unset seat_cap as 0 (does not poison the sum)', () => {
    expect(
      stakeAvailablePoolSize(
        200,
        [
          ward({ ward_code: 'CO', seat_cap: 50 }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ward({ ward_code: 'GE', seat_cap: undefined as any }),
        ],
        [building('Main')],
      ),
    ).toBe(150);
  });

  it('returns null when stake_seat_cap is unset', () => {
    expect(stakeAvailablePoolSize(undefined, [ward({ seat_cap: 20 })], [])).toBeNull();
    expect(stakeAvailablePoolSize(null, [ward({ seat_cap: 20 })], [])).toBeNull();
  });

  it('returns a negative value when ward caps exceed the stake cap (misconfiguration)', () => {
    // UtilizationBar handles cap <= 0 as the "(cap unset)" variant, so
    // the helper passes the negative through rather than clamping.
    expect(
      stakeAvailablePoolSize(
        100,
        [ward({ ward_code: 'CO', seat_cap: 60 }), ward({ ward_code: 'GE', seat_cap: 60 })],
        [building('Main')],
      ),
    ).toBe(-20);
  });

  it('excludes foreign-site ward caps (resolved via the ward building) from the reservation sum', () => {
    expect(
      stakeAvailablePoolSize(
        200,
        [
          ward({ ward_code: 'CO', seat_cap: 50, building_name: 'Home Building' }),
          ward({ ward_code: 'FN', seat_cap: 50, building_name: 'Foreign Building' }),
        ],
        [building('Home Building', null), building('Foreign Building', 'east-stake')],
      ),
    ).toBe(150);
  });

  it('treats a home-site building (kindoo_site_id null) as reserving against the stake pool', () => {
    expect(
      stakeAvailablePoolSize(
        200,
        [ward({ ward_code: 'CO', seat_cap: 50, building_name: 'Home Building' })],
        [building('Home Building', null)],
      ),
    ).toBe(150);
  });

  it('treats a ward whose building is unknown as home (reserves against the pool)', () => {
    expect(
      stakeAvailablePoolSize(
        200,
        [ward({ ward_code: 'CO', seat_cap: 50, building_name: 'Missing' })],
        [],
      ),
    ).toBe(150);
  });
});
