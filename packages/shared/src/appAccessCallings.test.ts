import { describe, expect, it } from 'vitest';
import {
  EQ_PRESIDENT_CALLING,
  LIMITED_TIER_CALLINGS,
  STAKE_APP_ACCESS_CALLINGS,
  WARD_APP_ACCESS_CALLINGS,
  appAccessCallingsForScope,
  filterAppAccessCallings,
  filterLimitedTierCallings,
} from './appAccessCallings.js';
import { callingSortOrder } from './callingSortOrder.js';

describe('app-access calling sets', () => {
  it('every hard-coded name resolves in the canonical order table (typo guard)', () => {
    for (const name of [
      ...WARD_APP_ACCESS_CALLINGS,
      ...STAKE_APP_ACCESS_CALLINGS,
      EQ_PRESIDENT_CALLING,
    ]) {
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

  it('omits Elders Quorum President from the ward set by default', () => {
    expect(appAccessCallingsForScope('CO').has('elders quorum president')).toBe(false);
    expect(appAccessCallingsForScope('CO', {}).has('elders quorum president')).toBe(false);
    expect(
      appAccessCallingsForScope('CO', { eqPresidentAccess: false }).has('elders quorum president'),
    ).toBe(false);
  });

  it('adds Elders Quorum President to the ward set when the stake opts in', () => {
    const set = appAccessCallingsForScope('CO', { eqPresidentAccess: true });
    expect(set.has('elders quorum president')).toBe(true);
    // The base ward callings are still present.
    expect(set.has('bishop')).toBe(true);
    expect(set.has('ward executive secretary')).toBe(true);
  });

  it('leaves the stake set unaffected by the opt-in', () => {
    const set = appAccessCallingsForScope('stake', { eqPresidentAccess: true });
    expect(set.has('elders quorum president')).toBe(false);
    expect(set.has('stake president')).toBe(true);
  });
});

describe('filterAppAccessCallings', () => {
  it('ward scope keeps Bishop and drops Elders Quorum President', () => {
    expect(filterAppAccessCallings('CO', ['Bishop', 'Elders Quorum President'])).toEqual([
      'Bishop',
    ]);
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

  it('ward scope keeps Elders Quorum President when the stake opts in', () => {
    expect(
      filterAppAccessCallings('CO', ['Bishop', 'Elders Quorum President'], {
        eqPresidentAccess: true,
      }),
    ).toEqual(['Bishop', 'Elders Quorum President']);
  });

  it('matches an opted-in Elders Quorum President case- and whitespace-insensitively, preserving original casing', () => {
    expect(
      filterAppAccessCallings('CO', ['  eLDERS quorum PRESIDENT  '], {
        eqPresidentAccess: true,
      }),
    ).toEqual(['  eLDERS quorum PRESIDENT  ']);
  });

  it('stake scope still drops Elders Quorum President when the stake opts in', () => {
    expect(
      filterAppAccessCallings('stake', ['Stake Clerk', 'Elders Quorum President'], {
        eqPresidentAccess: true,
      }),
    ).toEqual(['Stake Clerk']);
  });

  it('opt-in covers the president title only, not the rest of the quorum presidency', () => {
    expect(
      filterAppAccessCallings(
        'CO',
        [
          'Elders Quorum President',
          'Elders Quorum First Counselor',
          'Elders Quorum Second Counselor',
          'Elders Quorum Secretary',
        ],
        { eqPresidentAccess: true },
      ),
    ).toEqual(['Elders Quorum President']);
  });
});

describe('LIMITED_TIER_CALLINGS', () => {
  it('is exactly Elders Quorum President', () => {
    expect([...LIMITED_TIER_CALLINGS]).toEqual([EQ_PRESIDENT_CALLING]);
  });

  it('holds no base ward or stake app-access calling — those stay full-tier', () => {
    for (const name of [...WARD_APP_ACCESS_CALLINGS, ...STAKE_APP_ACCESS_CALLINGS]) {
      expect(LIMITED_TIER_CALLINGS.has(name)).toBe(false);
    }
  });
});

describe('filterLimitedTierCallings', () => {
  it('keeps only the limited-tier calling and preserves input order', () => {
    expect(filterLimitedTierCallings(['Bishop', EQ_PRESIDENT_CALLING, 'Ward Clerk'])).toEqual([
      EQ_PRESIDENT_CALLING,
    ]);
  });

  it('returns an empty array when nothing is limited-tier', () => {
    expect(filterLimitedTierCallings(['Bishop', 'Ward Clerk'])).toEqual([]);
    expect(filterLimitedTierCallings([])).toEqual([]);
  });

  it('matches case- and whitespace-insensitively, preserving original casing', () => {
    // The result must be a literal subset of the input so it can be
    // stored verbatim beside `importer_callings[scope]`.
    expect(filterLimitedTierCallings(['  eLDERS quorum PRESIDENT  '])).toEqual([
      '  eLDERS quorum PRESIDENT  ',
    ]);
  });

  it('covers the president title only, not the rest of the quorum presidency', () => {
    expect(
      filterLimitedTierCallings([
        EQ_PRESIDENT_CALLING,
        'Elders Quorum First Counselor',
        'Elders Quorum Second Counselor',
        'Elders Quorum Secretary',
      ]),
    ).toEqual([EQ_PRESIDENT_CALLING]);
  });

  it('composes with filterAppAccessCallings — the writer stamps a subset of what it granted', () => {
    const granted = filterAppAccessCallings('CO', ['Bishop', EQ_PRESIDENT_CALLING], {
      eqPresidentAccess: true,
    });
    expect(granted).toEqual(['Bishop', EQ_PRESIDENT_CALLING]);
    expect(filterLimitedTierCallings(granted)).toEqual([EQ_PRESIDENT_CALLING]);
  });
});
