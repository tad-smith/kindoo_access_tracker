// Unit tests for the calling-template matcher.

import { describe, expect, it } from 'vitest';
import { buildTemplateIndex, matchTemplate, wildcardToRegex } from './parser.js';

describe('wildcardToRegex', () => {
  it('treats * as .* and anchors both ends', () => {
    expect(wildcardToRegex('Bishop').test('Bishop')).toBe(true);
    expect(wildcardToRegex('Bishop').test('Bishop ')).toBe(false);
    expect(wildcardToRegex('Stake High Councilor*').test('Stake High Councilor')).toBe(true);
    expect(
      wildcardToRegex('Stake High Councilor*').test('Stake High Councilor - Cordera Ward'),
    ).toBe(true);
    expect(wildcardToRegex('*').test('anything')).toBe(true);
    expect(wildcardToRegex('*').test('')).toBe(true);
    expect(wildcardToRegex('Second*Counselor').test('Second Counselor')).toBe(true);
    expect(wildcardToRegex('Second*Counselor').test('Second Ward Counselor')).toBe(true);
    expect(wildcardToRegex('Second*Counselor').test('First Counselor')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(wildcardToRegex('Clerk (Assistant)').test('Clerk (Assistant)')).toBe(true);
    expect(wildcardToRegex('Clerk (Assistant)').test('Clerk Assistant')).toBe(false);
    expect(wildcardToRegex('A.B').test('AxB')).toBe(false);
    expect(wildcardToRegex('A.B').test('A.B')).toBe(true);
  });
});

describe('matchTemplate', () => {
  const idx = buildTemplateIndex([
    { calling_name: 'Bishop', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
    {
      calling_name: 'Counselor *',
      give_app_access: false,
      auto_kindoo_access: false,
      sheet_order: 2,
    },
    {
      calling_name: '*Clerk*',
      give_app_access: false,
      auto_kindoo_access: false,
      sheet_order: 3,
    },
  ]);

  it('returns null for a non-matching calling', () => {
    expect(matchTemplate(idx, 'High Priest')).toBeNull();
  });

  it('exact match wins over wildcards', () => {
    const got = matchTemplate(idx, 'Bishop');
    expect(got?.calling_name).toBe('Bishop');
  });

  it('wildcard matches when no exact', () => {
    const got = matchTemplate(idx, 'Counselor One');
    expect(got?.calling_name).toBe('Counselor *');
  });

  it('among wildcards, sheet_order ascending wins', () => {
    const idx2 = buildTemplateIndex([
      {
        calling_name: 'Foo*',
        give_app_access: false,
        auto_kindoo_access: false,
        sheet_order: 5,
      },
      { calling_name: '*', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
    ]);
    const got = matchTemplate(idx2, 'Foo Bar');
    // sheet_order=1 (`*`) lands first, so it wins even though `Foo*` is more specific.
    expect(got?.calling_name).toBe('*');
  });
});
