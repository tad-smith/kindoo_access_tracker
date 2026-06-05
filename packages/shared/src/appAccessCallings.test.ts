import { describe, expect, it } from 'vitest';
import {
  STAKE_APP_ACCESS_CALLINGS,
  WARD_APP_ACCESS_CALLINGS,
  appAccessCallingsForScope,
  filterAppAccessCallings,
} from './appAccessCallings.js';
import { callingSortOrder } from './callingSortOrder.js';

describe('app-access calling sets', () => {
  it('every hard-coded name resolves in the canonical order table (typo guard)', () => {
    for (const name of [...WARD_APP_ACCESS_CALLINGS, ...STAKE_APP_ACCESS_CALLINGS]) {
      expect(callingSortOrder(name)).not.toBeNull();
    }
  });
});

describe('appAccessCallingsForScope', () => {
  it('returns the stake set for the stake scope', () => {
    const set = appAccessCallingsForScope('stake');
    expect(set.has('stake president')).toBe(true);
    expect(set.has('bishop')).toBe(false);
  });

  it('returns the ward set for any ward scope', () => {
    const set = appAccessCallingsForScope('CO');
    expect(set.has('bishop')).toBe(true);
    expect(set.has('stake president')).toBe(false);
  });
});

describe('filterAppAccessCallings', () => {
  it('ward scope keeps Bishop and drops Elders Quorum President', () => {
    expect(filterAppAccessCallings('CO', ['Bishop', 'Elders Quorum President'])).toEqual(['Bishop']);
  });

  it('stake scope keeps Stake Clerk and Stake High Councilor, drops Stake Young Men President', () => {
    expect(
      filterAppAccessCallings('stake', [
        'Stake Clerk',
        'Stake High Councilor',
        'Stake Young Men President',
      ]),
    ).toEqual(['Stake Clerk', 'Stake High Councilor']);
  });

  it('matches case-insensitively and preserves original casing', () => {
    expect(filterAppAccessCallings('CO', ['  bishop  '])).toEqual(['  bishop  ']);
  });
});
