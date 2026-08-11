// Tests for the `/auth/extension` redirect allowlist — the trust
// boundary that decides which extension may be handed a session token.
//
// The headline case is `rejects a well-formed callback origin belonging
// to an extension we don't trust`. Shape validation alone passes that
// one, and passing it means every extension installed in the manager's
// profile could harvest a token.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHROME_EXTENSION_ID } from '../../lib/links';
import {
  REDIRECT_URI_PATTERN,
  allowedExtensionIds,
  isAllowedRedirectUri,
} from './extensionRedirect';

/** Shape-valid and NOT ours — some other extension in the profile. */
const OTHER_ID = 'abcdefghijklmnopabcdefghijklmnop';
const DEV_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const uri = (id: string) => `https://${id}.chromiumapp.org/`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('REDIRECT_URI_PATTERN', () => {
  it('accepts a callback origin with or without a trailing slash', () => {
    expect(REDIRECT_URI_PATTERN.test(`https://${OTHER_ID}.chromiumapp.org`)).toBe(true);
    expect(REDIRECT_URI_PATTERN.test(`https://${OTHER_ID}.chromiumapp.org/`)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['http rather than https', `http://${OTHER_ID}.chromiumapp.org/`],
    ['an unrelated host', 'https://evil.example.com/'],
    [
      'the callback host as a prefix of another domain',
      `https://${OTHER_ID}.chromiumapp.org.evil.com/`,
    ],
    ['a path beyond the origin', `https://${OTHER_ID}.chromiumapp.org/steal`],
    ['a query string', `https://${OTHER_ID}.chromiumapp.org/?next=evil`],
    ['an id one character short', `https://${OTHER_ID.slice(1)}.chromiumapp.org/`],
    ['an id one character long', `https://${OTHER_ID}a.chromiumapp.org/`],
    ['an id outside the a-p alphabet', `https://${OTHER_ID.slice(1)}z.chromiumapp.org/`],
    ['an uppercase id', `https://${OTHER_ID.toUpperCase()}.chromiumapp.org/`],
    ['a subdomain under the callback host', `https://x.${OTHER_ID}.chromiumapp.org/`],
    // `$` anchors at end-of-input in JS (unlike Python, where it also
    // matches before a trailing newline) — pinned so a future rewrite
    // that adds the `m` flag fails here rather than in production.
    ['a trailing newline', `https://${OTHER_ID}.chromiumapp.org/\n`],
    ['a newline-smuggled second line', `https://${OTHER_ID}.chromiumapp.org/\nhttps://evil.com`],
  ])('rejects %s', (_label, value) => {
    expect(REDIRECT_URI_PATTERN.test(value)).toBe(false);
  });
});

describe('allowedExtensionIds', () => {
  it('always trusts the published extension', () => {
    expect(allowedExtensionIds().has(CHROME_EXTENSION_ID)).toBe(true);
  });

  it('adds ids from VITE_EXTENSION_IDS for unpacked dev builds', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', DEV_ID);
    expect(allowedExtensionIds().has(DEV_ID)).toBe(true);
    // Additive, never replacing — a dev build still trusts the real one.
    expect(allowedExtensionIds().has(CHROME_EXTENSION_ID)).toBe(true);
  });

  it('accepts a comma-separated list with surrounding whitespace', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', `  ${DEV_ID} , ${OTHER_ID}  `);
    const ids = allowedExtensionIds();
    expect(ids.has(DEV_ID)).toBe(true);
    expect(ids.has(OTHER_ID)).toBe(true);
  });

  it('normalises case, since Chrome ids are lowercase', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', DEV_ID.toUpperCase());
    expect(allowedExtensionIds().has(DEV_ID)).toBe(true);
  });

  // A typo must not widen the trust set, and must not take the build
  // down either — the published id keeps working regardless.
  it.each([
    ['a wildcard', '*'],
    ['a bare host', 'evil.example.com'],
    ['an id that is too short', OTHER_ID.slice(1)],
    ['an id outside the a-p alphabet', `${OTHER_ID.slice(1)}z`],
    ['an empty entry', ''],
  ])('drops %s from the env var without widening the set', (_label, value) => {
    vi.stubEnv('VITE_EXTENSION_IDS', value);
    const ids = allowedExtensionIds();
    expect([...ids]).toEqual([CHROME_EXTENSION_ID]);
  });

  it('falls back to the published extension alone when the var is unset', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', '');
    expect([...allowedExtensionIds()]).toEqual([CHROME_EXTENSION_ID]);
  });
});

describe('isAllowedRedirectUri', () => {
  it('accepts the published extension callback origin', () => {
    expect(isAllowedRedirectUri(uri(CHROME_EXTENSION_ID))).toBe(true);
    expect(isAllowedRedirectUri(`https://${CHROME_EXTENSION_ID}.chromiumapp.org`)).toBe(true);
  });

  // THE case. Every Chrome extension's callback origin has this shape,
  // so a shape-only check trusts every extension in the profile — one
  // holding just the `identity` permission could silently harvest a
  // token from a signed-in manager.
  it('rejects a well-formed callback origin belonging to an extension we do not trust', () => {
    expect(REDIRECT_URI_PATTERN.test(uri(OTHER_ID))).toBe(true);
    expect(isAllowedRedirectUri(uri(OTHER_ID))).toBe(false);
  });

  it('accepts an unpacked dev id once it is listed in the env var', () => {
    expect(isAllowedRedirectUri(uri(DEV_ID))).toBe(false);
    vi.stubEnv('VITE_EXTENSION_IDS', DEV_ID);
    expect(isAllowedRedirectUri(uri(DEV_ID))).toBe(true);
  });

  it('rejects a non-callback URL even when it embeds a trusted id', () => {
    expect(isAllowedRedirectUri(`https://evil.example.com/${CHROME_EXTENSION_ID}`)).toBe(false);
    expect(isAllowedRedirectUri(`https://${CHROME_EXTENSION_ID}.chromiumapp.org.evil.com/`)).toBe(
      false,
    );
  });
});
