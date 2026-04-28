// Phase-4 end-to-end specs that exercise the new SPA shell:
//   - Browser back/forward across navigations preserves the right
//     content under the persistent shell.
//   - Direct deep-link via the legacy `?p=hello` form bootstraps
//     correctly and lands on the hello page.
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
  // `?p=hello` lands on the Phase 4 placeholder. Without it, the
  // role-default redirect would send the manager to
  // `/manager/dashboard` (404 until Phase 5+).
  await page.goto('/?p=hello');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Phase 4 shell + deep-links', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('?p=hello deep-link lands on the hello page within the shell', async ({ page }) => {
    const email = 'manager@example.com';
    const { uid } = await createAuthUser({ email });
    await setCustomClaims(uid, {
      canonical: email,
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    });

    await page.goto('/?p=hello');
    await signInViaTestHatch(page, email, TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: /Hello, manager@example\.com/ })).toBeVisible();
    // Persistent shell — topbar email + sign-out + version visible too.
    await expect(page.getByLabel('Build version')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Sign out$/i }).first()).toBeVisible();
  });

  test('browser back/forward preserves shell + content', async ({ page }) => {
    // Phase 4 only ships /hello as a renderable destination; the
    // per-role default redirects (manager → /manager/dashboard etc.)
    // 404 until Phase 5+. We exercise back/forward by navigating
    // through three URLs that all land on the Hello page within the
    // shell:
    //   1. `/?p=hello` — the legacy deep-link resolver redirects to
    //                    `/hello` after the gate.
    //   2. `/hello` — direct hit on the placeholder route.
    //   3. back/forward through that history — shell stays mounted.
    const email = 'manager-bf@example.com';
    const { uid } = await createAuthUser({ email });
    await setCustomClaims(uid, {
      canonical: email,
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
      },
    });

    // Land on the Hello page via the `?p=hello` deep-link.
    await page.goto('/?p=hello');
    await signInViaTestHatch(page, email, TEST_PASSWORD);
    await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();

    const topbarBrand = page.locator('.kd-topbar-brand');
    await expect(topbarBrand).toBeVisible();

    // Direct navigation to `/hello` (different URL, same destination).
    await page.goto('/hello');
    await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();

    // Back to `/?p=hello` — gate redirects to `/hello` again, shell
    // stays mounted (no full reload).
    await page.goBack();
    await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();

    // Forward to `/hello` — content matches.
    await page.goForward();
    await expect(page.getByRole('heading', { name: /Hello/ })).toBeVisible();
    await expect(topbarBrand).toBeVisible();
  });

  test('mobile viewport (375x667) renders without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAsManager(page, 'mobile@example.com');
    await page.goto('/hello');

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
