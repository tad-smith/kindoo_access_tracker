// Phase 4 + Phase 5 end-to-end specs that exercise the SPA shell:
//   - Browser back/forward across navigations preserves the right
//     content under the persistent shell.
//   - Direct deep-link via the legacy `?p=mgr/dashboard` form
//     bootstraps correctly and lands on the Dashboard.
//   - Mobile viewport (375×667) renders without horizontal scroll
//     and keeps the topbar legible.
//
// Co-located with the Phase-2 sign-in specs (`auth-flow.spec.ts`)
// because they share the same emulator-driven sign-in choreography.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

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

async function signInAsManager(page: Page, email: string): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      csnorth: { manager: true, stake: false, wards: [] },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

/**
 * Default stake doc seed for these specs. Phase 7 setup-complete gate
 * (added 2026-04-29) routes users with `setup_complete !== true` to
 * SetupInProgress instead of Dashboard. Tests that exercise the
 * Dashboard / nav must seed `setup_complete: true` first, or their
 * shell never renders. Per `apps/web/src/lib/setupGate.ts`, an absent
 * stake doc is treated as setup-incomplete (Option A from the
 * staging-bug fix).
 */
async function seedSetupCompleteStake(over: Record<string, unknown> = {}): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_id: 'csnorth',
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    ...over,
  });
}

test.describe('Phase 5 shell + deep-links', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    // Seed the default setup-complete stake. Individual tests can
    // overwrite with `seedSetupCompleteStake({...})` if they need to
    // pin a specific `stake_name` etc.
    await seedSetupCompleteStake();
  });

  test('?p=mgr/dashboard deep-link lands on the Dashboard within the shell', async ({ page }) => {
    const email = 'manager@example.com';
    const { uid } = await createAuthUser({ email });
    await setCustomClaims(uid, {
      canonical: email,
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    });

    await page.goto('/?p=mgr/dashboard');
    await signInViaTestHatch(page, email, TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    // Persistent shell — build version visible (in the rail footer at
    // desktop width) and Logout reachable (Account section, in the
    // rail body).
    await expect(page.getByLabel('Build version').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Logout$/i }).first()).toBeVisible();
  });

  test('clicking a nav link swaps content but keeps the shell mounted', async ({ page }) => {
    await signInAsManager(page, 'manager-bf@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const brandbar = page.locator('.kd-brandbar-brand');
    await expect(brandbar).toBeVisible();

    await page.getByRole('link', { name: /^All Seats$/ }).click();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
    await expect(brandbar).toBeVisible();

    await page.getByRole('link', { name: /^Audit Log$/ }).click();
    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();
    await expect(brandbar).toBeVisible();

    // Back — shell stays mounted, content reverts.
    await page.goBack();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
    await expect(brandbar).toBeVisible();

    // Forward — same.
    await page.goForward();
    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();
    await expect(brandbar).toBeVisible();
  });

  test('topbar brand shows the stake name once the stake doc loads', async ({ page }) => {
    // Override the default seed with a deterministic display name.
    // The Shell's live `useFirestoreDoc(stakeRef(...))` subscription
    // should swap the topbar brand from the product-name fallback to
    // the `stake_name` value once the snapshot lands.
    await seedSetupCompleteStake({ stake_name: 'Test Stake (E2E)' });

    await signInAsManager(page, 'brand-bar@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const brand = page.locator('.kd-brandbar-brand');
    await expect(brand).toHaveText('Test Stake (E2E)');
  });

  test('topbar brand falls back to the product name when the stake_name field is empty', async ({
    page,
  }) => {
    // Phase 7 setup-complete gate (2026-04-29) means an absent stake
    // doc routes the user to SetupInProgress, where there's no
    // topbar to test. Pin the original intent of this spec — "topbar
    // never renders empty" — by seeding a setup-complete stake with
    // an empty `stake_name`, which still triggers the Shell's
    // product-name fallback.
    await seedSetupCompleteStake({ stake_name: '' });
    await signInAsManager(page, 'brand-bar-fallback@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const brand = page.locator('.kd-brandbar-brand');
    await expect(brand).toHaveText('Stake Building Access');
  });

  test('mobile viewport (375x667) renders without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAsManager(page, 'mobile@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Topbar legible — email visible (truncated is fine; the title
    // attribute carries the full address).
    // Phone width hides the email in the brand bar (it moves to the
    // drawer footer per the navigation redesign §7).
    await expect(page.locator('.kd-brandbar-email')).toHaveCount(0);
    // The hamburger replaces it.
    await expect(page.getByRole('button', { name: /open navigation/i })).toBeVisible();

    // No horizontal scroll: documentElement.scrollWidth must not
    // exceed clientWidth at the configured viewport.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
