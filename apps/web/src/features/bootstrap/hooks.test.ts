// Pure-function tests for hook helpers. Hook-level Firestore behaviour
// is covered by E2E (which runs against the emulator).

import { describe, expect, it } from 'vitest';
import type { Ward } from '@kindoo/shared';
import { buildingDeleteBlocker } from './hooks';

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

describe('buildingDeleteBlocker', () => {
  it('returns null when no ward references the building', () => {
    expect(buildingDeleteBlocker([])).toBeNull();
  });

  it('returns a friendly message listing referencing ward names + codes', () => {
    const msg = buildingDeleteBlocker([
      ward({ ward_code: 'CO', ward_name: 'Cordera' }),
      ward({ ward_code: 'PR', ward_name: 'Prairie' }),
    ]);
    expect(msg).toMatch(/Cannot delete/);
    expect(msg).toContain('referenced by 2 ward(s)');
    expect(msg).toContain('Cordera (CO)');
    expect(msg).toContain('Prairie (PR)');
  });

  it('singular case still labels the count', () => {
    const msg = buildingDeleteBlocker([ward({ ward_code: 'CO', ward_name: 'Cordera' })]);
    expect(msg).toContain('1 ward(s)');
    expect(msg).toContain('Cordera (CO)');
  });
});
