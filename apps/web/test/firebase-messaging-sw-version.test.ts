// The FCM service worker's compat SDK must track the installed `firebase`.
//
// Those two `importScripts` URLs are a runtime dependency of production that
// no lockfile pins and `pnpm audit` structurally cannot see. When the version
// was a literal it drifted unnoticed: the SW sat on compat 10.13.2 while the
// page's modular SDK reached 12.x — two majors of skew between the two
// Firebase runtimes in the same origin, with no signal anywhere.
//
// The template now carries a `__FIREBASE_SDK_VERSION__` placeholder that
// `firebaseMessagingSwPlugin` fills from `firebase/package.json`. These tests
// pin both halves of that contract, because a literal reintroduced by hand
// would still build and still work — until the next `firebase` bump silently
// reopened the skew.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const templateSource = readFileSync(
  resolve(__dirname, '../src/firebase-messaging-sw.template.js'),
  'utf8',
);
const configSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');

describe('firebase-messaging-sw template — SDK version', () => {
  it('loads both compat scripts through the placeholder, never a literal version', () => {
    const urls = [...templateSource.matchAll(/gstatic\.com\/firebasejs\/([^/]+)\//g)].map(
      (m) => m[1],
    );
    expect(urls).toHaveLength(2);
    for (const version of urls) {
      expect(version).toBe('__FIREBASE_SDK_VERSION__');
    }
  });

  it('substitutes every occurrence, not just the first', () => {
    // `.replace()` with a string pattern replaces one occurrence. The template
    // has two, so the plugin must use `replaceAll` — otherwise the messaging
    // script keeps the raw placeholder and the SW throws on registration.
    expect(configSource).toContain("replaceAll('__FIREBASE_SDK_VERSION__'");
  });

  it('sources the version from the installed firebase package', () => {
    expect(configSource).toContain("createRequire(import.meta.url)('firebase/package.json')");
    const installed = (
      createRequire(import.meta.url)('firebase/package.json') as { version: string }
    ).version;
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
  });
});
