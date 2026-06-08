// Static-serving smoke test for the end-user help guides.
//
// The guides are served by Firebase Hosting from `public/help/` (synced
// from `docs/user-guide/` by `sync-help.mjs`, which runs on the
// `prebuild` hook the Playwright webServer triggers). They live OUTSIDE
// the SPA router and must resolve to the real guide HTML — not the
// cached SPA shell — even with the PWA service worker active and
// controlling the page.
//
// This test loads `/` first and blocks until the Workbox SW has
// activated AND claimed the tab (`navigator.serviceWorker.controller`
// non-null, via `clientsClaim: true`), THEN navigates to `/help/*` — so
// the navigation is made with the SW sitting in front of it, the same
// state a returning PWA user is in. It asserts the guide's own
// `<h1>`/`<title>` renders and the SPA hero heading does not.
//
// What this does NOT isolate: the `navigateFallbackDenylist` entry for
// `/^\/help\//` in `vite.config.ts`. vite-plugin-pwa precaches the two
// `*.html` files in `public/` (they appear in the SW's precache
// manifest), so the precache route serves them directly and the
// navigation never reaches the navigation-fallback route — meaning the
// guides resolve correctly with OR without the denylist entry. The
// denylist entry is kept as cheap, intent-documenting defense for any
// `/help/*` path that is not precached (and to guard a future build that
// stops precaching the HTML). Static-only — no emulator state required.

import { expect, test, type Page } from '@playwright/test';

// Load the app root and block until the Workbox SW has activated AND
// claimed this page, so the subsequent `/help/*` navigation is made with
// the SW in control — the realistic returning-PWA-user condition.
async function waitForControllingServiceWorker(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return false;
      // `controller` is set once an activated worker has claimed the
      // page (clientsClaim).
      return navigator.serviceWorker.controller !== null;
    },
    undefined,
    { timeout: 30_000 },
  );
}

test('the requester guide serves real guide HTML with the SW controlling the page', async ({
  page,
}) => {
  await waitForControllingServiceWorker(page);

  // Navigated with an active, controlling SW in front of us.
  await page.goto('/help/requesting-access.html');

  // The guide's own <h1> + <title> prove the real static file was
  // served. The SPA shell's hero heading is "Building access for your
  // stake." — distinct, so a fallback-to-shell would fail here.
  await expect(
    page.getByRole('heading', { level: 1, name: /Requesting Building Access/i }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/Requesting Building Access/i);

  // Belt-and-braces: the SPA hero heading must NOT be present — confirms
  // we did not get the shell.
  await expect(
    page.getByRole('heading', { level: 1, name: /Building access for your stake/i }),
  ).toHaveCount(0);
});

test('the Kindoo Manager guide serves real guide HTML with the SW controlling the page', async ({
  page,
}) => {
  await waitForControllingServiceWorker(page);

  await page.goto('/help/kindoo-manager-guide.html');

  await expect(
    page.getByRole('heading', { level: 1, name: /Kindoo Manager Guide/i }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/Kindoo Manager Guide/i);
});
