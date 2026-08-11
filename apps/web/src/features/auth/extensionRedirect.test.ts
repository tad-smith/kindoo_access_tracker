// Tests for the `/auth/extension` redirect allowlist — the trust
// boundary that decides which extension may be handed a session token.
//
// Two headline cases:
//   - `rejects a well-formed callback origin belonging to an extension
//     we don't trust`. Shape validation alone passes that one, and
//     passing it means every extension in the manager's profile could
//     harvest a token.
//   - `does not trust the published extension in a staging build`. The
//     Web Store ID is not the ID any unpacked build carries, so an
//     implicit default there is an identity that cannot legitimately
//     appear — and it would mask a missing `VITE_EXTENSION_IDS`, which
//     is the misconfiguration that silently breaks staging entirely.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHROME_EXTENSION_ID } from '../../lib/links';
import {
  REDIRECT_URI_PATTERN,
  allowedExtensionIds,
  extensionAllowlistIsEmpty,
  isAllowedRedirectUri,
} from './extensionRedirect';

/** Shape-valid and NOT ours — some other extension in the profile. */
const OTHER_ID = 'abcdefghijklmnopabcdefghijklmnop';
/** Stands in for a keypair-derived unpacked id (staging / local dev). */
const DEV_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const uri = (id: string) => `https://${id}.chromiumapp.org/`;

beforeEach(() => {
  // Vitest runs in mode `test`; the production default is keyed on
  // mode, so each test states the build it means to exercise.
  vi.stubEnv('MODE', 'production');
});

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

describe('allowedExtensionIds — production build', () => {
  it('trusts the published extension with no env var set', () => {
    expect([...allowedExtensionIds()]).toEqual([CHROME_EXTENSION_ID]);
  });

  // The runbook has the operator smoke-test a prod-mode unpacked build
  // against the production origin before uploading. That build carries
  // the keypair id, not the Web Store id, so production has to be able
  // to admit an extra one.
  it('admits an additional keypair id alongside the published one', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', DEV_ID);
    const ids = allowedExtensionIds();
    expect(ids.has(CHROME_EXTENSION_ID)).toBe(true);
    expect(ids.has(DEV_ID)).toBe(true);
  });

  // The property the fallback exists for: production sign-in must not
  // be breakable by a missing or fat-fingered env var.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['a wildcard', '*'],
    ['a bare host', 'evil.example.com'],
    ['an id that is too short', OTHER_ID.slice(1)],
  ])('still trusts the published extension when the var is %s', (_label, value) => {
    if (value !== undefined) vi.stubEnv('VITE_EXTENSION_IDS', value);
    expect([...allowedExtensionIds()]).toEqual([CHROME_EXTENSION_ID]);
  });
});

describe('allowedExtensionIds — staging build', () => {
  beforeEach(() => {
    vi.stubEnv('MODE', 'staging');
  });

  // The regression this whole change exists for. The staging extension
  // is an unpacked build with its own keypair-derived id; the Web Store
  // id belongs to an extension pinned to the production origin, which
  // cannot be the caller here.
  it('does not trust the published extension', () => {
    expect(allowedExtensionIds().has(CHROME_EXTENSION_ID)).toBe(false);
    expect(isAllowedRedirectUri(uri(CHROME_EXTENSION_ID))).toBe(false);
  });

  it('trusts exactly what VITE_EXTENSION_IDS lists', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', DEV_ID);
    expect([...allowedExtensionIds()]).toEqual([DEV_ID]);
    expect(isAllowedRedirectUri(uri(DEV_ID))).toBe(true);
  });

  // `vite build --mode staging` fails before reaching this state; the
  // dev server does not, which is why the route names the cause.
  it('reports an empty allowlist when the var is unset', () => {
    expect(extensionAllowlistIsEmpty()).toBe(true);
    expect(isAllowedRedirectUri(uri(DEV_ID))).toBe(false);
  });

  it('is not empty once an id is configured', () => {
    vi.stubEnv('VITE_EXTENSION_IDS', DEV_ID);
    expect(extensionAllowlistIsEmpty()).toBe(false);
  });
});

describe('allowedExtensionIds — parsing', () => {
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

  // A typo must not widen the trust set. It also must not take the
  // build down: the valid neighbours in the list still apply.
  it('drops malformed entries but keeps the valid ones beside them', () => {
    vi.stubEnv('MODE', 'staging');
    vi.stubEnv('VITE_EXTENSION_IDS', `*, ${DEV_ID}, evil.example.com, ${OTHER_ID.slice(1)}`);
    expect([...allowedExtensionIds()]).toEqual([DEV_ID]);
  });
});

describe('isAllowedRedirectUri', () => {
  it('accepts the published extension callback origin in production', () => {
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

  it('accepts an unpacked id once it is listed in the env var', () => {
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
