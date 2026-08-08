// Tests for `sanitizeSlugInput`. The load-bearing case is the trailing
// hyphen: it has to survive mid-typing (or word boundaries collapse and
// `cs North` becomes `csnorth`) while never surviving into a stored
// value. The rest pin the same lowercase / collapse rules `buildingSlug`
// applies, plus the two relationships between the two helpers.
import { describe, expect, it } from 'vitest';
import { buildingSlug } from './buildingSlug.js';
import { sanitizeSlugInput } from './slugInput.js';

describe('sanitizeSlugInput', () => {
  it('keeps a trailing hyphen so a word boundary survives mid-typing', () => {
    expect(sanitizeSlugInput('cs ')).toBe('cs-');
    expect(sanitizeSlugInput('cs-')).toBe('cs-');
  });

  it('builds `cs-north` keystroke by keystroke from `CS North`', () => {
    // The regression this helper exists for: replaying the characters
    // one at a time has to land on `cs-north`, not `csnorth`.
    let value = '';
    for (const char of 'CS North') {
      value = sanitizeSlugInput(value + char);
    }
    expect(value).toBe('cs-north');
  });

  it('folds uppercase to lowercase', () => {
    expect(sanitizeSlugInput('CS North')).toBe('cs-north');
    expect(sanitizeSlugInput('UPPER')).toBe('upper');
  });

  it('turns spaces into hyphens rather than dropping them', () => {
    expect(sanitizeSlugInput('cedar springs north')).toBe('cedar-springs-north');
  });

  it('collapses runs of spaces, punctuation, and hyphens to one hyphen', () => {
    expect(sanitizeSlugInput('a    b')).toBe('a-b');
    expect(sanitizeSlugInput("st. mary's --- stake")).toBe('st-mary-s-stake');
    expect(sanitizeSlugInput('foo___bar')).toBe('foo-bar');
  });

  it('trims leading hyphens — a separator before any content has no boundary to keep', () => {
    expect(sanitizeSlugInput('  cs')).toBe('cs');
    expect(sanitizeSlugInput('---cs')).toBe('cs');
  });

  it('preserves digits', () => {
    expect(sanitizeSlugInput('Stake 17')).toBe('stake-17');
  });

  it('returns empty string for null / undefined / empty / pure-punctuation input', () => {
    expect(sanitizeSlugInput(null)).toBe('');
    expect(sanitizeSlugInput(undefined)).toBe('');
    expect(sanitizeSlugInput('')).toBe('');
    expect(sanitizeSlugInput('!!!')).toBe('');
    expect(sanitizeSlugInput('   ')).toBe('');
  });

  it('yields a fixed point of buildingSlug whenever it has no trailing hyphen', () => {
    for (const raw of ['CS North', "St. Mary's Stake", 'Building 17', 'foo___bar', '  cs']) {
      const sanitized = sanitizeSlugInput(raw);
      expect(sanitized.endsWith('-')).toBe(false);
      expect(buildingSlug(sanitized)).toBe(sanitized);
    }
  });

  it('never changes the slug the server derives', () => {
    // The field rewrites what the operator typed; that rewrite must not
    // move the resulting doc ID, or the visible value and the created
    // stake would disagree.
    for (const raw of ['CS North', 'cs ', "St. Mary's --- Stake!", '  cs', '###', '', 'Stake 17']) {
      expect(buildingSlug(sanitizeSlugInput(raw))).toBe(buildingSlug(raw));
    }
  });
});
