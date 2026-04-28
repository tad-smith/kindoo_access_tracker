// Cross-cutting smoke spec. One hermetic check that the SPA preview
// build comes up without throwing. Does NOT depend on emulator state —
// the anonymous landing page (SignInPage) renders synchronously on
// mount, before the Firebase SDK reaches out for auth/Firestore.
//
// Phase 1 asserted a placeholder smoketest heading. Phase 2 replaced
// that with the real SignInPage as the anonymous landing — the heading
// is now `Kindoo Access Tracker`, the same one the auth-flow specs'
// "anonymous visit" test asserts. We keep this smoke separate from
// auth-flow because it doesn't need the Auth/Firestore emulators
// running, so it stays useful when the larger suite is gated behind
// emulator boot.

import { expect, test } from '@playwright/test';

test('SPA preview build renders the anonymous landing page', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Kindoo Access Tracker/i })).toBeVisible();
});
