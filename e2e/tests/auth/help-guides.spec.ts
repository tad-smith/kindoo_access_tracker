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

// Section deep-linking: a copy-link icon is injected after every h2/h3
// (except the ToC) by the guides' inline script. Clicking it copies the
// absolute section URL and shows a "Link copied" affordance without
// jumping. The requester guide's "Install it like an app" subsection has
// a stable authored id (`install-app`) so its shareable link is clean.
test('the requester guide injects copy-link anchors on its sections', async ({ page }) => {
  await page.goto('/help/requesting-access.html');

  // Every numbered section heading gets an anchor; none appear in the ToC.
  await expect(page.locator('main.page h2 a.anchor').first()).toBeAttached();
  await expect(page.locator('nav.toc a.anchor')).toHaveCount(0);

  // The Install subsection keeps its authored id and its anchor.
  await expect(page.locator('h3#install-app a.anchor')).toHaveCount(1);
});

test('clicking a section copy-link copies the absolute deep-link and confirms it', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/help/requesting-access.html');

  const installAnchor = page.locator('h3#install-app a.anchor');
  await installAnchor.click();

  // Hash updates to the section id — no navigation away, no full jump.
  await expect(page).toHaveURL(/\/help\/requesting-access\.html#install-app$/);

  // The "Link copied" affordance is shown (the `.copied` class drives the
  // ::after tooltip).
  await expect(installAnchor).toHaveClass(/copied/);

  // The clipboard holds the absolute, shareable deep-link.
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/\/help\/requesting-access\.html#install-app$/);
});

test('the requester guide deep-links to the expanded Install subsection', async ({ page }) => {
  await page.goto('/help/requesting-access.html#install-app');

  const install = page.locator('h3#install-app');
  await expect(install).toBeVisible();
  await expect(install).toHaveText(/Install it like an app/i);

  // The subsection was expanded into a concrete per-platform install
  // table (heading → intro paragraph → table).
  const installTable = page.locator('h3#install-app + p + table');
  await expect(installTable).toBeVisible();
  await expect(installTable).toContainText('iPhone / iPad');
  await expect(installTable).toContainText('Add to Home Screen');
  await expect(installTable).toContainText('Windows / Chromebook');
});
