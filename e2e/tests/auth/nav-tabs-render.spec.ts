// Regression spec for the navigation redesign (Phase 10.1). The
// sectioned left rail / icons rail / drawer replaces the Phase 5 top
// tab bar. This spec confirms:
//
//   1. Active item gets the brand-color left-edge accent bar (§5
//      "3–4px vertical bar on the left edge in the accent color"),
//      not a bottom-border underline. Inactive items have a
//      transparent left-edge marker so the geometry doesn't shift on
//      activation.
//   2. Active item carries the brand-tint background fill (§12
//      "subtle background color change behind the entire item row").
//      Inactive items are flat (no fill).
//   3. The active link is rendered as an `<a>` with
//      `aria-current="page"` — the tab-bar a11y pattern survived the
//      redesign.
//
// Auth required (the Shell only renders the rail for authenticated
// principals); we use the same `signInViaTestHatch` choreography as
// the other auth-flow specs.

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

test.describe('Sectioned rail — active-state styling', () => {
  test.beforeEach(async ({ page }) => {
    await clearAuth();
    await clearFirestore();
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: true,
    });
    // Force desktop width so the persistent rail renders.
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('active link has a brand-color left-edge accent + brand-tint background; inactive is flat', async ({
    page,
  }) => {
    await signInAsManager(page, 'rail-active@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const activeLink = page.getByRole('link', { name: /Dashboard/ });
    const inactiveLink = page.getByRole('link', { name: /All Seats/ });
    await expect(activeLink).toBeVisible();
    await expect(inactiveLink).toBeVisible();

    // ----- Active link: left-edge brand accent + brand-tint bg -----

    const activeStyles = await activeLink.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        borderLeftWidth: cs.borderLeftWidth,
        borderLeftColor: cs.borderLeftColor,
      };
    });

    // The left-edge accent is the new active indicator.
    expect(parseFloat(activeStyles.borderLeftWidth)).toBeGreaterThan(0);
    expect(activeStyles.borderLeftColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(activeStyles.borderLeftColor).not.toBe('transparent');

    // Brand primary `#2b6cb0` is the canonical accent color
    // (`tokens.css`); both the accent stripe and the active text take
    // that color.
    const expectedPrimary = 'rgb(43, 108, 176)';
    expect(activeStyles.borderLeftColor).toBe(expectedPrimary);
    expect(activeStyles.color).toBe(expectedPrimary);

    // Background is the brand tint, not transparent.
    expect(activeStyles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(activeStyles.backgroundColor).not.toBe('transparent');

    // ----- Inactive link: flat (no fill, transparent left edge) -----

    const inactiveStyles = await inactiveLink.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        borderLeftWidth: cs.borderLeftWidth,
        borderLeftColor: cs.borderLeftColor,
      };
    });

    // Inactive left-edge marker is transparent (so geometry doesn't
    // shift on activation), and there's no background fill.
    expect(inactiveStyles.borderLeftColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
    expect(inactiveStyles.backgroundColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
  });

  test('the active link advertises itself with aria-current="page"', async ({ page }) => {
    await signInAsManager(page, 'rail-aria@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const active = page.getByRole('link', { name: /Dashboard/ });
    await expect(active).toHaveAttribute('aria-current', 'page');

    const inactive = page.getByRole('link', { name: /All Seats/ });
    await expect(inactive).not.toHaveAttribute('aria-current', 'page');
  });
});
