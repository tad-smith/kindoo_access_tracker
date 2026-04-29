// End-to-end tests for the bootstrap-wizard gate per `docs/spec.md`
// §10. Covers:
//   1. Bootstrap admin signs in against a `setup_complete=false` stake
//      → wizard renders.
//   2. Non-admin signs in against the same stake → SetupInProgress
//      (distinct from NotAuthorized).
//   3. Wizard step bar exposes all four steps.
//
// Wizard CRUD against the emulator is exercised at the integration
// layer (`apps/web/src/features/bootstrap/*.test.tsx`); E2E proves the
// gate routing decision.

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

test.describe('Bootstrap wizard gate', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('bootstrap admin sees the wizard when setup_complete=false', async ({ page }) => {
    const adminEmail = 'admin@example.com';
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
      callings_sheet_id: '',
      stake_seat_cap: 0,
    });

    const { uid } = await createAuthUser({ email: adminEmail });
    await setCustomClaims(uid, {
      canonical: adminEmail,
      stakes: {},
    });

    await page.goto('/');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Set up Stake Building Access/i }),
    ).toBeVisible();
    // All four step tabs are visible.
    await expect(page.getByTestId('wizard-step-tab-1')).toBeVisible();
    await expect(page.getByTestId('wizard-step-tab-2')).toBeVisible();
    await expect(page.getByTestId('wizard-step-tab-3')).toBeVisible();
    await expect(page.getByTestId('wizard-step-tab-4')).toBeVisible();
  });

  test('non-admin sees SetupInProgress (distinct from NotAuthorized)', async ({ page }) => {
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: false,
    });

    const otherEmail = 'random@example.com';
    const { uid } = await createAuthUser({ email: otherEmail });
    await setCustomClaims(uid, { canonical: otherEmail, stakes: {} });

    await page.goto('/');
    await signInViaTestHatch(page, otherEmail, TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: /Setup in progress/i })).toBeVisible();
    // SetupInProgress is distinct from NotAuthorized — no sign-out button.
    await expect(page.getByRole('button', { name: /^Sign out$/i })).toHaveCount(0);
  });

  test('?p= deep-link is ignored during bootstrap', async ({ page }) => {
    const adminEmail = 'admin2@example.com';
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
    });

    const { uid } = await createAuthUser({ email: adminEmail });
    await setCustomClaims(uid, { canonical: adminEmail, stakes: {} });

    await page.goto('/?p=mgr/dashboard');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    // Wizard renders, NOT the dashboard, even though we passed ?p=mgr/dashboard.
    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toHaveCount(0);
  });
});
