// Tests for the `VITE_EXTENSION_IDS` parser. Shared by the runtime
// allowlist and the build-time prerequisite check in `vite.config.ts`,
// so "did this value configure anything" has to mean the same thing on
// both sides — a build that accepted a value the runtime drops would
// ship the exact silent refusal the check exists to prevent.

import { describe, expect, it } from 'vitest';
import { parseExtensionIds } from './extensionIds';

const A = 'abcdefghijklmnopabcdefghijklmnop';
const B = 'ponmlkjihgfedcbaponmlkjihgfedcba';

describe('parseExtensionIds', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['only separators', ',,, ,'],
  ])('returns nothing for %s', (_label, value) => {
    expect(parseExtensionIds(value)).toEqual([]);
  });

  it('parses a single id', () => {
    expect(parseExtensionIds(A)).toEqual([A]);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    expect(parseExtensionIds(`  ${A} ,${B}  `)).toEqual([A, B]);
  });

  it('lowercases, since Chrome ids are lowercase', () => {
    expect(parseExtensionIds(A.toUpperCase())).toEqual([A]);
  });

  it('de-duplicates so a repeated id is listed once', () => {
    expect(parseExtensionIds(`${A},${A},${B}`)).toEqual([A, B]);
  });

  // Dropping rather than throwing: this is a trust set, so a typo must
  // fail closed on that entry instead of widening the set — or taking
  // down a build whose other entries are fine.
  it.each([
    ['a wildcard', '*'],
    ['a bare host', 'evil.example.com'],
    ['a full URL', `https://${A}.chromiumapp.org/`],
    ['an id one character short', A.slice(1)],
    ['an id one character long', `${A}a`],
    ['an id outside the a-p alphabet', `${A.slice(1)}z`],
    ['an id with a digit', `${A.slice(1)}1`],
  ])('drops %s', (_label, value) => {
    expect(parseExtensionIds(value)).toEqual([]);
  });

  it('keeps valid ids listed beside malformed ones', () => {
    expect(parseExtensionIds(`*, ${A}, evil.example.com, ${B}`)).toEqual([A, B]);
  });
});
