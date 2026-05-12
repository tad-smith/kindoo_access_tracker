// Tests for canonicalEmail / emailsEqual. Cover lowercase + trim, the
// Gmail dot/+suffix collapse, the googlemail.com fold, and the
// preserve-as-typed behaviour for non-Gmail providers.
import { describe, expect, it } from 'vitest';
import { canonicalEmail, emailsEqual } from './canonicalEmail.js';

describe('canonicalEmail', () => {
  it('lowercases and strips dots from gmail.com local-part', () => {
    expect(canonicalEmail('Alice.Smith@Gmail.com')).toBe('alicesmith@gmail.com');
  });

  it('folds googlemail.com to gmail.com and drops +suffix', () => {
    expect(canonicalEmail('alicesmith+church@googlemail.com')).toBe('alicesmith@gmail.com');
  });

  it('preserves dots on non-Gmail addresses', () => {
    expect(canonicalEmail('alice@csnorth.org')).toBe('alice@csnorth.org');
  });

  it('preserves dots and +suffix on Workspace / non-Gmail addresses', () => {
    // architecture.md D4: non-Gmail providers treat dots and +suffix as
    // significant, so we leave them alone.
    expect(canonicalEmail('first.last@example.org')).toBe('first.last@example.org');
    expect(canonicalEmail('alice+church@example.org')).toBe('alice+church@example.org');
  });

  it('trims whitespace and lowercases generic addresses', () => {
    expect(canonicalEmail('  Bob@Foo.COM  ')).toBe('bob@foo.com');
  });

  it('returns empty string for null / undefined / empty input', () => {
    expect(canonicalEmail(null)).toBe('');
    expect(canonicalEmail(undefined)).toBe('');
    expect(canonicalEmail('')).toBe('');
  });

  it('passes through input with no @ sign', () => {
    expect(canonicalEmail('no-at-sign')).toBe('no-at-sign');
  });
});

describe('emailsEqual', () => {
  it('treats Gmail dot/+suffix variants as equal', () => {
    expect(emailsEqual('First.Last@gmail.com', 'firstlast@gmail.com')).toBe(true);
    expect(emailsEqual('first.last+church@gmail.com', 'firstlast@gmail.com')).toBe(true);
    expect(emailsEqual('First.Last@Gmail.com', 'firstlast@googlemail.com')).toBe(true);
  });

  it('returns false for distinct addresses', () => {
    expect(emailsEqual('a@example.com', 'b@example.com')).toBe(false);
  });

  it('treats dots on non-Gmail addresses as significant', () => {
    // Workspace / corporate domains: dots ARE part of the address.
    expect(emailsEqual('first.last@example.org', 'firstlast@example.org')).toBe(false);
  });

  it('handles null / empty inputs symmetrically', () => {
    expect(emailsEqual('', '')).toBe(true);
    expect(emailsEqual(null, undefined)).toBe(true);
  });
});
