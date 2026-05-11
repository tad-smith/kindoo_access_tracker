// Static assertion that vite.config.ts's Workbox `navigateFallbackDenylist`
// covers every raw static asset Firebase Hosting serves.
//
// Background: the NavigationRoute installed by vite-plugin-pwa
// rewrites every same-origin navigation to `index.html` by default.
// A click on `<a href="/THIRD_PARTY_LICENSES.txt">` is a navigation
// request, so without an entry in `navigateFallbackDenylist` the SW
// serves the SPA shell and the user sees "Not Found." This regressed
// the T-20 licenses link on first deploy.
//
// The test reads vite.config.ts as text and asserts the denylist
// array contains the regex literals it must. A function-based eval
// of the config is possible but brittle (it loads env, picks up the
// router plugin, etc.). The text-level check is fast, deterministic,
// and load-bearing for the contract we ship.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG_PATH = resolve(__dirname, '..', 'vite.config.ts');

function readConfigSource(): string {
  return readFileSync(CONFIG_PATH, 'utf8');
}

function extractDenylist(src: string): string {
  const match = src.match(/navigateFallbackDenylist:\s*\[([\s\S]*?)\]/);
  if (!match || match[1] === undefined) {
    throw new Error('navigateFallbackDenylist array not found in vite.config.ts');
  }
  return match[1];
}

describe('vite.config.ts — Workbox navigateFallbackDenylist', () => {
  it('contains the /THIRD_PARTY_LICENSES.txt regex literal (T-20)', () => {
    const denylist = extractDenylist(readConfigSource());
    expect(denylist).toContain('/^\\/THIRD_PARTY_LICENSES\\.txt$/');
  });

  it('contains the /firebase-messaging-sw.js regex literal', () => {
    const denylist = extractDenylist(readConfigSource());
    expect(denylist).toContain('/^\\/firebase-messaging-sw\\.js$/');
  });

  it('contains the Firebase Hosting reserved /__/ prefix regex literal', () => {
    const denylist = extractDenylist(readConfigSource());
    expect(denylist).toContain('/^\\/__\\//');
  });
});
