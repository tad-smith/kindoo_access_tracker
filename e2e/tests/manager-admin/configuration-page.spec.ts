// Smoke test for the Phase 7 manager admin pages: Configuration +
// Import. Confirms the nav links appear, the routes load, and the
// per-tab CRUD UI renders. Mutation behaviour is tested at the
// component layer (apps/web/src/features/manager/configuration/*.test.tsx)
// against mocked hooks; this proves the route exists and the page
// renders with a real bundle.

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
  // Seed a setup-complete stake so the bootstrap gate is bypassed.
  await writeDoc('stakes/csnorth', {
    stake_id: 'csnorth',
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    callings_sheet_id: 'sheet1',
  });
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

test.describe('Manager admin pages (Phase 7)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('manager nav exposes Configuration + Import', async ({ page }) => {
    await signInAsManager(page, 'mgr@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Configuration$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Import$/ })).toBeVisible();
  });

  test('Configuration route renders the Wards tab by default', async ({ page }) => {
    await signInAsManager(page, 'mgr-cfg@example.com');
    await page.getByRole('link', { name: /^Configuration$/ }).click();
    await expect(page.getByRole('heading', { name: /^Configuration$/ })).toBeVisible();
    // Default tab is wards — heading "Wards" rendered.
    await expect(page.getByTestId('config-tab-wards')).toBeVisible();
  });

  test('Configuration deep-link to ?tab=managers lands on the Managers panel', async ({ page }) => {
    await signInAsManager(page, 'mgr-cfg2@example.com');
    await page.goto('/manager/configuration?tab=managers');
    await expect(page.getByRole('heading', { name: /Kindoo Managers/i })).toBeVisible();
  });

  test('Import route renders the Import Now button + status block', async ({ page }) => {
    await signInAsManager(page, 'mgr-import@example.com');
    await page.getByRole('link', { name: /^Import$/ }).click();
    await expect(page.getByRole('heading', { name: /^Import$/ })).toBeVisible();
    await expect(page.getByTestId('import-now-button')).toBeVisible();
    await expect(page.getByTestId('import-callings-sheet-id')).toHaveText('sheet1');
  });
});
