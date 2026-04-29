// Pure-function tests for configuration hook helpers. Live Firestore
// behaviour is covered by E2E.

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

describe('configuration buildingDeleteBlocker', () => {
  it('returns null when no ward references the building', () => {
    expect(buildingDeleteBlocker([])).toBeNull();
  });

  it('returns a message listing referencing ward names + codes', () => {
    const msg = buildingDeleteBlocker([
      ward({ ward_code: 'CO', ward_name: 'Cordera' }),
      ward({ ward_code: 'PR', ward_name: 'Prairie' }),
    ]);
    expect(msg).toContain('Cannot delete');
    expect(msg).toContain('2 ward(s)');
    expect(msg).toContain('Cordera (CO)');
    expect(msg).toContain('Prairie (PR)');
  });
});
