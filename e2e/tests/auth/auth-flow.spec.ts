// Phase 2 + Phase 5 end-to-end auth-flow specs. Covers the four proofs
// from the Phase-2 acceptance criteria, refreshed for the Phase-5 page
// set:
//   1. Anonymous visit → SignInPage renders.
//   2. Sign in via Auth emulator (no claims yet) → NotAuthorizedPage.
//   3. Sign in with role claims pre-seeded → manager Dashboard
//      renders within the persistent shell (Phase-4 hello placeholder
//      retired in Phase 5).
//   4. Sign-out from the Dashboard → returns to SignInPage.
//
// Custom claims are set directly on the emulator user (proof of "claims
// reach the SDK + decode correctly") rather than going through the full
// `onAuthUserCreate` trigger — that trigger lives in `functions/` and
// is the backend-engineer's territory; their integration tests cover
// trigger correctness. The web's contract is "given claims on the
// token, render the right page", which is what this spec proves.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

/**
 * Drive the SPA's emulator-only sign-in hatch from the test runner.
 * The hatch is exposed by `apps/web/src/lib/firebase.ts` only when
 * `VITE_USE_AUTH_EMULATOR=true` is set (the playwright webServer config
 * sets it). Calling `signInWithEmailAndPassword` against the Auth
 * emulator with a synthetic user is the test analogue of the real
 * Google popup — same `User` shape, same custom-claims flow.
 */
async function signInViaTestHatch(page: Page, email: string, password: string): Promise<void> {
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __KINDOO_TEST__?: unknown }).__KINDOO_TEST__),
  );
  await page.evaluate(
    async (creds: { email: string; password: string }) => {
      const hatch = (
        window as unknown as {
          __KINDOO_TEST__: {
            signInWithEmailAndPassword: (e: string, p: string) => Promise<void>;
          };
        }
      ).__KINDOO_TEST__;
      await hatch.signInWithEmailAndPassword(creds.email, creds.password);
    },
    { email, password },
  );
}

test.describe('auth-flow', () => {
  test.beforeEach(async () => {
    // Reset emulator state between tests so each one is hermetic.
    // We assume the operator has booted the Auth + Firestore emulators
    // before running the suite; the helpers throw if they can't reach
    // the REST endpoints.
    await clearAuth();
    await clearFirestore();
  });

  test('anonymous visit shows the SignInPage', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Kindoo Access Tracker/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign in with Google/i })).toBeVisible();
  });

  test('signed-in user with no role claims sees NotAuthorizedPage', async ({ page }) => {
    await createAuthUser({ email: 'noclaims@example.com' });
    await page.goto('/');
    await signInViaTestHatch(page, 'noclaims@example.com', TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: /Not authorized/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign out/i })).toBeVisible();
  });

  test('signed-in manager lands on the Dashboard within the shell', async ({ page }) => {
    const { uid } = await createAuthUser({ email: 'manager@example.com' });
    // Pre-seed: kindooManagers doc + custom claims that the
    // `onAuthUserCreate` / `syncManagersClaims` triggers would set in
    // production. The seed simulates "trigger has run".
    await writeDoc('stakes/csnorth/kindooManagers/manager@example.com', {
      email: 'manager@example.com',
      active: true,
    });
    await setCustomClaims(uid, {
      canonical: 'manager@example.com',
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    });

    await page.goto('/');
    await signInViaTestHatch(page, 'manager@example.com', TEST_PASSWORD);

    // Manager default landing per spec.md §5: /manager/dashboard.
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    // Persistent shell stays mounted — topbar email + sign-out present.
    await expect(page.getByRole('button', { name: /^Sign out$/i }).first()).toBeVisible();
  });

  test('sign-out from the Dashboard returns to SignInPage', async ({ page }) => {
    const { uid } = await createAuthUser({ email: 'manager2@example.com' });
    await setCustomClaims(uid, {
      canonical: 'manager2@example.com',
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    });

    await page.goto('/');
    await signInViaTestHatch(page, 'manager2@example.com', TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    await page
      .getByRole('button', { name: /^Sign out$/i })
      .first()
      .click();

    await expect(page.getByRole('button', { name: /Sign in with Google/i })).toBeVisible();
  });
});
