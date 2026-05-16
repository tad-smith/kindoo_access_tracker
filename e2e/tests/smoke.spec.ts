// Cross-cutting smoke spec. One hermetic check that the SPA preview
// build comes up without throwing. Does NOT depend on emulator state —
// the anonymous landing page (SignInPage) renders synchronously on
// mount, before the Firebase SDK reaches out for auth/Firestore.
//
// Asserts the hero <h1> on the new homepage plus the topbar brand
// wordmark, so a regression that drops either surface is caught.

import { expect, test } from '@playwright/test';

test('SPA preview build renders the anonymous landing page', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: /Building access for your stake/i }),
  ).toBeVisible();
  await expect(page.getByText(/Stake Building Access/i).first()).toBeVisible();
});
