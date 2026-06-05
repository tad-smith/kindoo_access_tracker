import { describe, expect, it } from 'vitest';
import { scopeLabel } from './scopeLabel.js';
import type { Ward } from './types/ward.js';

// Minimal Ward factory — only the fields the resolver reads.
function ward(partial: Pick<Ward, 'ward_code' | 'ward_name'>): Ward {
  return partial as Ward;
}

const wards = [
  ward({ ward_code: 'CO', ward_name: 'Maple' }),
  ward({ ward_code: 'MR', ward_name: 'Meadow Run' }),
];

describe('scopeLabel', () => {
  it('labels the stake scope as "Stake"', () => {
    expect(scopeLabel('stake', wards)).toBe('Stake');
  });

  it('resolves a ward code to its ward_name', () => {
    expect(scopeLabel('CO', wards)).toBe('Maple');
    expect(scopeLabel('MR', wards)).toBe('Meadow Run');
  });

  it('falls back to the raw code when the ward is not in the catalogue', () => {
    expect(scopeLabel('ZZ', wards)).toBe('ZZ');
  });

  it('falls back to the raw code when the wards list is empty (not yet hydrated)', () => {
    expect(scopeLabel('CO', [])).toBe('CO');
  });
});
