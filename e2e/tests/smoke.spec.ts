// Phase 1 smoke spec.
//
// Boots the SPA preview build and asserts the page heading is rendered.
// Does NOT assert the smoketest doc was loaded — `_smoketest/hello` may
// not be seeded when this runs (the seed step is operator-driven). The
// only contract Phase 1 makes is "the page comes up without throwing".

import { expect, test } from '@playwright/test';

test('smoketest page renders the Phase 1 heading', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Kindoo .* Phase 1 smoketest/ })).toBeVisible();
});
