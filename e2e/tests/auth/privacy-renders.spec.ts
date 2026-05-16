// `/privacy` is reachable while signed out (no `_authed` gate) so a
// Chrome Web Store reviewer can read the policy without authenticating.
// This spec is the per-page E2E coverage required by `e2e/CLAUDE.md`:
// navigate unauthenticated, confirm the page <h1> renders and the
// "Back to home" footer link points home. Static-only — no emulator
// state required.

import { expect, test } from '@playwright/test';

test('anonymous visit to /privacy renders the policy and a Back-to-home link', async ({ page }) => {
  await page.goto('/privacy');

  await expect(page.getByRole('heading', { level: 1, name: /Privacy policy/i })).toBeVisible();

  const backLink = page.getByRole('link', { name: /Back to home/i });
  await expect(backLink).toBeVisible();
  await expect(backLink).toHaveAttribute('href', '/');
});
