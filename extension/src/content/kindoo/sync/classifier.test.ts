// Classifier tests. Verifies each outcome the detector relies on:
// auto-match, no-match, mixed callings (review tiebreaker), temp
// override, unresolved-scope fallback.

import { describe, expect, it } from 'vitest';
import type { CallingTemplate } from '@kindoo/shared';
import type { ParsedSegment } from './parser';
import { buildCallingTemplateSets, classifySegment } from './classifier';

function ts(): CallingTemplate['created_at'] {
  return {
    seconds: 0,
    nanoseconds: 0,
    toDate: () => new Date(0),
    toMillis: () => 0,
  };
}

function template(overrides: Partial<CallingTemplate>): CallingTemplate {
  return {
    calling_name: 'X',
    give_app_access: true,
    auto_kindoo_access: true,
    sheet_order: 1,
    created_at: ts(),
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
    ...overrides,
  };
}

function segment(overrides: Partial<ParsedSegment>): ParsedSegment {
  return {
    rawScopeName: 'Cordera Ward',
    scope: 'CO',
    calling: 'Sunday School Teacher',
    resolvedScope: true,
    ...overrides,
  };
}

const STAKE_TEMPLATES = [
  template({ calling_name: 'Stake Clerk' }),
  template({ calling_name: 'Stake Executive Secretary', auto_kindoo_access: false }),
];
const WARD_TEMPLATES = [
  template({ calling_name: 'Sunday School Teacher' }),
  template({ calling_name: 'Elders Quorum President' }),
  template({ calling_name: 'Bishop', auto_kindoo_access: false }),
];
const WARD_CODES = ['CO', 'PC', 'MO'];

const SETS = buildCallingTemplateSets(STAKE_TEMPLATES, WARD_TEMPLATES, WARD_CODES);

describe('buildCallingTemplateSets', () => {
  it('only includes templates with auto_kindoo_access=true', () => {
    expect(SETS.stakeCallings.has('stake clerk')).toBe(true);
    expect(SETS.stakeCallings.has('stake executive secretary')).toBe(false);
    const ward = SETS.wardCallings.get('CO');
    expect(ward?.has('bishop')).toBe(false);
    expect(ward?.has('sunday school teacher')).toBe(true);
  });

  it('seeds every supplied ward code with the same auto-set (UNION pattern)', () => {
    for (const code of WARD_CODES) {
      expect(SETS.wardCallings.get(code)?.has('sunday school teacher')).toBe(true);
    }
  });

  it('returns an empty stake set when there are no stake auto callings', () => {
    const empty = buildCallingTemplateSets([], WARD_TEMPLATES, WARD_CODES);
    expect(empty.stakeCallings.size).toBe(0);
  });
});

describe('classifySegment', () => {
  it('returns type=temp when IsTempUser is true regardless of calling match', () => {
    const result = classifySegment(segment({ calling: 'Sunday School Teacher' }), true, SETS);
    expect(result.type).toBe('temp');
    expect(result.callings).toEqual([]);
    expect(result.freeText).toBe('Sunday School Teacher');
    expect(result.reviewMixed).toBe(false);
  });

  it('classifies a single auto-matching calling as type=auto', () => {
    const result = classifySegment(segment({ calling: 'Sunday School Teacher' }), false, SETS);
    expect(result.type).toBe('auto');
    expect(result.callings).toEqual(['Sunday School Teacher']);
    expect(result.freeText).toBe('');
    expect(result.reviewMixed).toBe(false);
  });

  it('classifies all auto-matching multi-calling segment as type=auto', () => {
    const result = classifySegment(
      segment({ calling: 'Sunday School Teacher, Elders Quorum President' }),
      false,
      SETS,
    );
    expect(result.type).toBe('auto');
    expect(result.callings).toEqual(['Sunday School Teacher', 'Elders Quorum President']);
    expect(result.reviewMixed).toBe(false);
  });

  it('classifies a no-match calling as type=manual and surfaces the raw text', () => {
    const result = classifySegment(segment({ calling: 'Building Janitor' }), false, SETS);
    expect(result.type).toBe('manual');
    expect(result.callings).toEqual([]);
    expect(result.freeText).toBe('Building Janitor');
    expect(result.reviewMixed).toBe(false);
  });

  it('classifies a mixed-callings segment as manual + reviewMixed=true (tiebreaker)', () => {
    const result = classifySegment(
      segment({ calling: 'Sunday School Teacher, Building Janitor' }),
      false,
      SETS,
    );
    expect(result.type).toBe('manual');
    expect(result.reviewMixed).toBe(true);
    // matched callings stay for diagnostic context
    expect(result.callings).toEqual(['Sunday School Teacher']);
    // unmatched lives in freeText
    expect(result.freeText).toBe('Building Janitor');
  });

  it('falls back to manual + scope=null when the parsed segment did not resolve its scope', () => {
    const result = classifySegment(
      segment({ scope: null, resolvedScope: false, calling: 'Some calling' }),
      false,
      SETS,
    );
    expect(result.type).toBe('manual');
    expect(result.scope).toBeNull();
    expect(result.freeText).toBe('Some calling');
  });

  it('matches case-insensitively', () => {
    const result = classifySegment(segment({ calling: 'SUNDAY school TEACHER' }), false, SETS);
    expect(result.type).toBe('auto');
    expect(result.callings).toEqual(['SUNDAY school TEACHER']);
  });

  it('classifies a stake-scope auto calling as type=auto', () => {
    const result = classifySegment(
      segment({
        scope: 'stake',
        rawScopeName: 'Colorado Springs North Stake',
        calling: 'Stake Clerk',
      }),
      false,
      SETS,
    );
    expect(result.type).toBe('auto');
  });

  it('classifies a stake-scope non-auto calling as type=manual', () => {
    const result = classifySegment(
      segment({
        scope: 'stake',
        rawScopeName: 'Colorado Springs North Stake',
        calling: 'Stake President',
      }),
      false,
      SETS,
    );
    expect(result.type).toBe('manual');
    expect(result.freeText).toBe('Stake President');
  });

  it('treats an empty parens body as manual with empty callings', () => {
    const result = classifySegment(segment({ calling: '' }), false, SETS);
    expect(result.type).toBe('manual');
    expect(result.callings).toEqual([]);
    expect(result.freeText).toBe('');
  });

  it('treats an unknown ward scope as manual (no auto set seeded for that ward)', () => {
    const result = classifySegment(
      segment({ scope: 'XX', resolvedScope: true, calling: 'Sunday School Teacher' }),
      false,
      SETS,
    );
    // No XX entry → empty set → no auto match.
    expect(result.type).toBe('manual');
  });
});
