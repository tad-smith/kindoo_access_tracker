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

test.describe('Phase 5 shell + deep-links', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
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
    // Persistent shell — topbar build version + sign-out + email visible too.
    await expect(page.getByLabel('Build version')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Sign out$/i }).first()).toBeVisible();
  });

  test('clicking a nav link swaps content but keeps the shell mounted', async ({ page }) => {
    await signInAsManager(page, 'manager-bf@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const topbarBrand = page.locator('.kd-topbar-brand');
    await expect(topbarBrand).toBeVisible();

    await page.getByRole('link', { name: /^All Seats$/ }).click();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();

    await page.getByRole('link', { name: /^Audit Log$/ }).click();
    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();

    // Back — shell stays mounted, content reverts.
    await page.goBack();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();

    // Forward — same.
    await page.goForward();
    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();
  });

  test('mobile viewport (375x667) renders without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAsManager(page, 'mobile@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Topbar legible — email visible (truncated is fine; the title
    // attribute carries the full address).
    await expect(page.locator('.kd-topbar-email')).toBeVisible();

    // No horizontal scroll: documentElement.scrollWidth must not
    // exceed clientWidth at the configured viewport.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
