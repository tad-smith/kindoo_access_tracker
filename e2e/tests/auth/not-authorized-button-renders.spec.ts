// Regression spec mirrored from `sign-in-button-renders.spec.ts` for
// NotAuthorizedPage. Same preflight bug class as PR #12: a bare
// `<button>` zeroed by Tailwind v4's preflight (background transparent,
// border 0, padding 0, cursor default) renders as plain text. Routing
// through the shadcn `<Button>` primitive restores the `.btn` chrome.
//
// We need to actually reach the page, which means signing in as a user
// with no role claims (the failure-mode arm covered by NotAuthorized).
// The `setup_complete` stake doc is required so the Phase 7 setup gate
// doesn't intercept the user before role-resolution falls through.

import { expect, test } from '@playwright/test';
import { clearAuth, clearFirestore, createAuthUser, writeDoc } from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

test.describe('NotAuthorizedPage button renders as a styled, clickable button', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('"Sign out" has visible chrome (background, padding, pointer cursor)', async ({ page }) => {
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: true,
    });
    await createAuthUser({ email: 'noclaims@example.com' });

    await page.goto('/');

    // Drive the same emulator-only test hatch the auth-flow spec uses.
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
      { email: 'noclaims@example.com', password: TEST_PASSWORD },
    );

    // Wait for NotAuthorizedPage to render.
    await expect(page.getByRole('heading', { name: /Not authorized/i })).toBeVisible();

    const button = page.getByRole('button', { name: /Sign out/i });
    await expect(button).toBeVisible();

    // Non-zero bounding box.
    const box = await button.boundingBox();
    expect(box, 'button must have a layout box').not.toBeNull();
    if (!box) return;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);

    // Computed style snapshot. Same three-axis check as the SignInPage
    // spec: background not transparent, padding non-zero, cursor pointer.
    const styles = await button.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        paddingTop: cs.paddingTop,
        paddingLeft: cs.paddingLeft,
        cursor: cs.cursor,
      };
    });

    expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.backgroundColor).not.toBe('transparent');

    expect(parseFloat(styles.paddingTop)).toBeGreaterThan(0);
    expect(parseFloat(styles.paddingLeft)).toBeGreaterThan(0);

    expect(styles.cursor).toBe('pointer');
  });
});
