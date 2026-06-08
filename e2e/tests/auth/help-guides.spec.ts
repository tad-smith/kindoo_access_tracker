// The static end-user guides are served by Firebase Hosting from
// `public/help/` (synced from `docs/user-guide/` by `sync-help.mjs`,
// which runs on the `prebuild` hook the Playwright webServer triggers).
// They live OUTSIDE the SPA router and must resolve to the real guide
// HTML — not the cached SPA shell.
//
// This spec is the regression guard for the PWA navigateFallbackDenylist
// entry (`/^\/help\//` in `vite.config.ts`): without it the service
// worker rewrites `/help/*` navigations to `index.html`, and the user
// gets the sign-in page instead of the guide. Static-only — no emulator
// state required.

import { expect, test } from '@playwright/test';

test('the static requester guide resolves to the guide HTML, not the SPA shell', async ({
  page,
}) => {
  await page.goto('/help/requesting-access.html');

  // The guide's own <h1> proves the real static file was served. The SPA
  // shell's hero heading is "Building access for your stake." — distinct,
  // so a fallback-to-shell would fail this assertion.
  await expect(
    page.getByRole('heading', { level: 1, name: /Requesting Building Access/i }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/Requesting Building Access/i);

  // The SPA hero heading must NOT be present — confirms we did not get
  // the shell.
  await expect(
    page.getByRole('heading', { level: 1, name: /Building access for your stake/i }),
  ).toHaveCount(0);
});

test('the static Kindoo Manager guide resolves to the guide HTML', async ({ page }) => {
  await page.goto('/help/kindoo-manager-guide.html');

  await expect(
    page.getByRole('heading', { level: 1, name: /Kindoo Manager Guide/i }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/Kindoo Manager Guide/i);
});
