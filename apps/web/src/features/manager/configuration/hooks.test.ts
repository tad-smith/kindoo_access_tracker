// Pure-function tests for configuration hook helpers. Live Firestore
// behaviour is covered by E2E.

import { describe, expect, it } from 'vitest';
import type { Ward } from '@kindoo/shared';
import {
  buildingDeleteBlocker,
  nextSheetOrder,
  planDeleteResequenceWrites,
  planReorderWrites,
} from './hooks';

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

describe('configuration nextSheetOrder', () => {
  it('returns 1 when the existing list is empty', () => {
    expect(nextSheetOrder([])).toBe(1);
  });

  it('returns max+1 across the existing rows', () => {
    expect(nextSheetOrder([{ sheet_order: 1 }, { sheet_order: 5 }, { sheet_order: 3 }])).toBe(6);
  });
});

describe('configuration planReorderWrites', () => {
  it('returns the rows whose new contiguous order differs from current', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    // Move C to top → only A→2, B→3, C→1 differ.
    const writes = planReorderWrites(['C', 'A', 'B'], current);
    expect(writes).toEqual([
      { calling_name: 'C', sheet_order: 1 },
      { calling_name: 'A', sheet_order: 2 },
      { calling_name: 'B', sheet_order: 3 },
    ]);
  });

  it('skips rows whose order is already correct', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    // Identity reorder → no writes.
    expect(planReorderWrites(['A', 'B', 'C'], current)).toEqual([]);
  });

  it('writes only the changed positions when adjacent rows swap', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    const writes = planReorderWrites(['A', 'C', 'B'], current);
    expect(writes).toEqual([
      { calling_name: 'C', sheet_order: 2 },
      { calling_name: 'B', sheet_order: 3 },
    ]);
  });
});

describe('configuration planDeleteResequenceWrites', () => {
  it('renumbers survivors to contiguous 1..N-1 when middle row is deleted', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    expect(planDeleteResequenceWrites('B', current)).toEqual([
      { calling_name: 'C', sheet_order: 2 },
    ]);
  });

  it('returns no writes when the deleted row is at the end', () => {
    const current = [
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'B', sheet_order: 2 },
      { calling_name: 'C', sheet_order: 3 },
    ];
    expect(planDeleteResequenceWrites('C', current)).toEqual([]);
  });

  it('handles non-contiguous starting state by writing every survivor that needs to move', () => {
    const current = [
      { calling_name: 'A', sheet_order: 5 },
      { calling_name: 'B', sheet_order: 7 },
      { calling_name: 'C', sheet_order: 9 },
    ];
    expect(planDeleteResequenceWrites('B', current)).toEqual([
      { calling_name: 'A', sheet_order: 1 },
      { calling_name: 'C', sheet_order: 2 },
    ]);
  });
});
