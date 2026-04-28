// Tests for `buildingSlug`. The §4.3 example pins the canonical
// transformation (`'Cordera Building'` → `'cordera-building'`); the
// remaining cases lock in determinism and the edges that decide
// whether two slightly-different display names collide.
import { describe, expect, it } from 'vitest';
import { buildingSlug } from './buildingSlug.js';

describe('buildingSlug', () => {
  it('matches the firebase-schema.md §4.3 example', () => {
    expect(buildingSlug('Cordera Building')).toBe('cordera-building');
  });

  it('is deterministic across repeated calls', () => {
    expect(buildingSlug('Some Building')).toBe(buildingSlug('Some Building'));
  });

  it('lowercases', () => {
    expect(buildingSlug('UPPER CASE')).toBe('upper-case');
  });

  it('collapses internal whitespace runs', () => {
    expect(buildingSlug('A    B')).toBe('a-b');
  });

  it('strips punctuation', () => {
    expect(buildingSlug("St. John's Building")).toBe('st-john-s-building');
  });

  it('trims leading and trailing hyphens', () => {
    expect(buildingSlug('  Cordera  ')).toBe('cordera');
    expect(buildingSlug('!!!Foo!!!')).toBe('foo');
  });

  it('collapses interior hyphen runs to a single hyphen', () => {
    expect(buildingSlug('Foo - Bar')).toBe('foo-bar');
  });

  it('drops non-ASCII characters (current behaviour; see file header)', () => {
    expect(buildingSlug('Mañana Building')).toBe('ma-ana-building');
  });

  it('preserves digits', () => {
    expect(buildingSlug('Building 17')).toBe('building-17');
  });

  it('returns empty string for null / undefined / empty / pure-punctuation input', () => {
    expect(buildingSlug(null)).toBe('');
    expect(buildingSlug(undefined)).toBe('');
    expect(buildingSlug('')).toBe('');
    expect(buildingSlug('!!!')).toBe('');
  });
});
