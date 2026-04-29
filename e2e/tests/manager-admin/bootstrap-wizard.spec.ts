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

  test('manager-claimed user during setup_complete=false sees SetupInProgress', async ({
    page,
  }) => {
    // Staging-bug regression (2026-04-29). A user who already holds
    // manager claims (e.g., from a prior staging Phase 2 test) signs
    // in against a stake doc with setup_complete=false. The
    // setup-complete gate must take precedence over claims-based
    // routing — the user MUST land on SetupInProgress, not on the
    // role-default Dashboard.
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: false,
    });

    const mgrEmail = 'mgr-during-setup@example.com';
    const { uid } = await createAuthUser({ email: mgrEmail });
    // Manager claim — same shape syncManagersClaims would mint.
    await setCustomClaims(uid, {
      canonical: mgrEmail,
      stakes: { csnorth: { manager: true } },
    });

    await page.goto('/');
    await signInViaTestHatch(page, mgrEmail, TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: /Setup in progress/i })).toBeVisible();
    // Dashboard heading must NOT appear — proves the setup gate
    // overrode the manager-default landing.
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toHaveCount(0);
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

  // Add+delete cycle for each wizard collection. Operator regression
  // (2026-04-28): deletes were silently failing because the rules used
  // `allow write` with the `lastActorMatchesAuth` integrity check that
  // can't evaluate against `request.resource.data` on delete. Rules now
  // split create/update from delete. These tests prove the live wizard
  // can both add and remove rows under bootstrap-admin auth against the
  // real emulator rules.
  test('wizard add+delete cycle works for buildings', async ({ page }) => {
    const adminEmail = 'admin-bld@example.com';
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
    });
    const { uid } = await createAuthUser({ email: adminEmail });
    await setCustomClaims(uid, { canonical: adminEmail, stakes: {} });
    await page.goto('/');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await page.getByTestId('wizard-step-tab-2').click();

    // Add.
    await page.getByLabel(/^Building name$/).fill('Cordera Building');
    await page.getByLabel(/^Address$/).fill('1 Cordera Cir');
    await page.getByRole('button', { name: /^Add building$/ }).click();

    const list = page.getByTestId('bootstrap-buildings-list');
    await expect(list.getByText('Cordera Building')).toBeVisible();

    // Delete (uses the building_id slug derived from the name).
    await page.getByTestId('bootstrap-building-delete-cordera-building').click();
    await expect(list.getByText('Cordera Building')).toHaveCount(0);
  });

  test('wizard add+delete cycle works for wards', async ({ page }) => {
    const adminEmail = 'admin-ward@example.com';
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
    });
    const { uid } = await createAuthUser({ email: adminEmail });
    await setCustomClaims(uid, { canonical: adminEmail, stakes: {} });
    await page.goto('/');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    // Add a building first (wards reference one).
    const step2 = page.getByTestId('wizard-step-2');
    await page.getByTestId('wizard-step-tab-2').click();
    await step2.getByLabel(/^Building name$/).fill('Main Building');
    await step2.getByLabel(/^Address$/).fill('1 Main St');
    await step2.getByRole('button', { name: /^Add building$/ }).click();
    await expect(
      page.getByTestId('bootstrap-buildings-list').getByText('Main Building'),
    ).toBeVisible();

    // Wards tab — add + delete. Scope all field locators to the
    // step-3 panel testid. The Building <select> sits inside an
    // implicit-label parent (`<label>Building <select>...</select>
    // </label>`); Playwright's getByLabel against an implicit label
    // concatenates the option text into the accessible name, so we
    // target the <select> by role + nearest preceding label text
    // instead.
    await page.getByTestId('wizard-step-tab-3').click();
    const step3 = page.getByTestId('wizard-step-3');
    await expect(step3.getByRole('heading', { name: /^Wards$/ })).toBeVisible();
    // Wait for the building option to populate the select before
    // attempting to select it (the Firestore listener may still be
    // catching up after the Step 2 add).
    await expect(step3.getByRole('option', { name: 'Main Building' })).toHaveCount(1);
    await step3.getByLabel(/^Ward code$/).fill('CO');
    await step3.getByLabel(/^Ward name$/).fill('Cordera Ward');
    await step3.locator('select').selectOption('Main Building');
    await step3.getByLabel(/^Seat cap$/).fill('20');
    await step3.getByRole('button', { name: /^Add ward$/ }).click();

    const list = page.getByTestId('bootstrap-wards-list');
    await expect(list.getByText(/Cordera Ward \(CO\)/)).toBeVisible();
    await page.getByTestId('bootstrap-ward-delete-CO').click();
    await expect(list.getByText(/Cordera Ward \(CO\)/)).toHaveCount(0);
  });

  test('wizard add+delete cycle works for managers', async ({ page }) => {
    const adminEmail = 'admin-mgr@example.com';
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
    });
    const { uid } = await createAuthUser({ email: adminEmail });
    await setCustomClaims(uid, { canonical: adminEmail, stakes: {} });
    await page.goto('/');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await page.getByTestId('wizard-step-tab-4').click();

    // The bootstrap admin is auto-added — wait for that row, then add a
    // second manager and delete it. The auto-add seeds `name` to the
    // principal email, so each row contains the email twice (once in
    // `<strong>` for name, once in `<code>` for member_email). Locate
    // by the `<code>` element to keep the assertion strict-mode-safe.
    const list = page.getByTestId('bootstrap-managers-list');
    await expect(list.locator('code', { hasText: adminEmail })).toBeVisible();

    const otherEmail = 'second-mgr@example.com';
    const step4 = page.getByTestId('wizard-step-4');
    await step4.getByLabel(/^Email$/).fill(otherEmail);
    await step4.getByLabel(/^Name$/).fill('Second Mgr');
    await step4.getByRole('button', { name: /^Add manager$/ }).click();
    await expect(list.locator('code', { hasText: otherEmail })).toBeVisible();

    await page.getByTestId(`bootstrap-manager-delete-${otherEmail}`).click();
    await expect(list.locator('code', { hasText: otherEmail })).toHaveCount(0);

    // Bootstrap-admin row hides BOTH delete and toggle (regression).
    await expect(page.getByTestId(`bootstrap-manager-delete-${adminEmail}`)).toHaveCount(0);
    await expect(page.getByTestId(`bootstrap-manager-toggle-${adminEmail}`)).toHaveCount(0);
  });
});
