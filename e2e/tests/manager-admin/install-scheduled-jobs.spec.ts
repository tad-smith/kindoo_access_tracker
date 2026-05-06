// End-to-end test for the bootstrap-wizard "Complete Setup" idempotent
// install of `installScheduledJobs` (Phase 8 + T-25). Drives the live
// callable through the local Functions emulator: signs in as the
// bootstrap admin, walks the wizard to a finishable state, clicks
// Complete Setup, and asserts the success indicator. Then re-invokes
// the callable directly via the SDK to prove the second call returns
// the same `{ ok: true }` shape with no error — the idempotency
// criterion the task names.
//
// The callable's idempotency comes from its design: per
// `functions/src/callable/installScheduledJobs.ts`, there are no
// per-stake jobs to install (the single-loop scheduler hooks the
// importer / expiry / reconcile triggers off platform-managed Cloud
// Scheduler jobs). The callable only verifies the caller is an active
// manager and the stake's schedule fields are populated. Calling it N
// times after a successful setup must produce N identical successes.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  waitForServerStakeClaim,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';
const STAKE_ID = 'csnorth';

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

/**
 * Drive `httpsCallable` directly via the SDK already wired into the
 * preview build. Used to invoke `installScheduledJobs` a second time
 * without re-walking the wizard (which can only be walked once before
 * `setup_complete=true` gates it shut).
 */
async function invokeCallable<T = unknown>(page: Page, name: string, data: unknown): Promise<T> {
  return await page.evaluate<T, { name: string; data: unknown }>(
    async ({ name, data }) => {
      const hatch = (
        window as unknown as {
          __KINDOO_TEST__: {
            invokeCallable: (n: string, d: unknown) => Promise<unknown>;
          };
        }
      ).__KINDOO_TEST__;
      return (await hatch.invokeCallable(name, data)) as T;
    },
    { name, data },
  );
}

test.describe('Bootstrap wizard install-scheduled-jobs (live Functions emulator)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('Complete Setup invokes installScheduledJobs and second invocation is idempotent', async ({
    page,
  }) => {
    const adminEmail = 'admin@example.com';

    // Pre-seed a stake doc with `setup_complete=false` plus the
    // schedule fields the callable's defensive checks require. The
    // wizard normally fills in `import_hour` etc. via Step 1, but Step
    // 1's form only collects `stake_name + callings_sheet_id +
    // stake_seat_cap` — the rest are seeded by `createStake` (Phase
    // 12). Mirror that here so the callable's `failed-precondition`
    // checks pass after Complete Setup flips setup_complete.
    await writeDoc(`stakes/${STAKE_ID}`, {
      stake_id: STAKE_ID,
      stake_name: '',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
      stake_seat_cap: 0,
      callings_sheet_id: '',
      expiry_hour: 3,
      import_day: 'MONDAY',
      import_hour: 4,
      timezone: 'America/Denver',
      notifications_enabled: true,
    });

    // Pre-seed the kindooManagers doc BEFORE creating the auth user
    // so `onAuthUserCreate` reads the active manager record and stamps
    // the correct claims at first sign-in (canonical + manager:true on
    // STAKE_ID). This avoids a triple-trigger race against
    // `setCustomClaims` (which would otherwise be the obvious shortcut
    // but loses to whichever trigger writes claims last). After Complete
    // Setup flips setup_complete=true, the post-setup redirect routes
    // the claim-bearing user to the manager dashboard (Shell mounts
    // ToastHost so the "Setup complete!" toast survives navigation).
    // Pre-seed manager custom claims AND the kindooManagers doc so the
    // post-Complete-Setup redirect routes the now-claim-bearing user
    // to the manager dashboard (Shell + ToastHost) — the success toast
    // survives the navigation. The `installScheduledJobs` callable
    // reads the kindooManagers doc directly so its post-setup
    // invocation succeeds independent of claim plumbing.
    //
    // Order is load-bearing: pre-seeding the kindooManagers doc BEFORE
    // creating the auth user ensures `onAuthUserCreate` reads it on
    // first sign-in and stamps the manager claim itself (rather than
    // racing against our synthetic `setCustomClaims`). The `await
    // waitForServerStakeClaim` then blocks until the trigger has
    // committed — sign-in's first force-refresh now returns a token
    // whose claims are in the desired terminal state.
    await writeDoc(`stakes/${STAKE_ID}/kindooManagers/${adminEmail}`, {
      member_canonical: adminEmail,
      member_email: adminEmail,
      name: adminEmail,
      active: true,
    });
    const { uid } = await createAuthUser({ email: adminEmail });
    await waitForServerStakeClaim(uid, STAKE_ID);

    await page.goto('/');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible({ timeout: 30_000 });

    // Step 1 — fill in stake name + seat cap.
    const step1 = page.getByTestId('wizard-step-1');
    await step1.getByLabel(/^Stake name$/).fill('Test Stake');
    await step1.getByLabel(/^Stake seat cap$/).fill('100');
    await step1.getByRole('button', { name: /^Save$/ }).click();
    // Wait for the saved-toast confirmation that the stake doc landed
    // before flipping tabs (defensive against the live Firestore
    // listener catching up).
    await expect(page.getByText(/Stake settings saved/i)).toBeVisible();

    // Step 2 — add a building.
    await page.getByTestId('wizard-step-tab-2').click();
    const step2 = page.getByTestId('wizard-step-2');
    await step2.getByLabel(/^Building name$/).fill('Cordera Building');
    await step2.getByLabel(/^Address$/).fill('1 Cordera Cir');
    await step2.getByRole('button', { name: /^Add building$/ }).click();
    await expect(
      page.getByTestId('bootstrap-buildings-list').getByText('Cordera Building'),
    ).toBeVisible();

    // Step 3 — add a ward referencing the building.
    await page.getByTestId('wizard-step-tab-3').click();
    const step3 = page.getByTestId('wizard-step-3');
    await expect(step3.getByRole('option', { name: 'Cordera Building' })).toHaveCount(1);
    await step3.getByLabel(/^Ward code$/).fill('CO');
    await step3.getByLabel(/^Ward name$/).fill('Cordera Ward');
    await step3.locator('select').selectOption('Cordera Building');
    await step3.getByLabel(/^Seat cap$/).fill('20');
    await step3.getByRole('button', { name: /^Add ward$/ }).click();
    await expect(
      page.getByTestId('bootstrap-wards-list').getByText(/Cordera Ward \(CO\)/),
    ).toBeVisible();

    // Complete Setup is enabled once steps 1-3 are valid.
    const completeButton = page.getByTestId('bootstrap-complete-setup');
    await expect(completeButton).toBeEnabled();
    await completeButton.click();

    // Success toast surfaces (the wizard fires "Setup complete!" after
    // the callable resolves OK, or a warn-toast on callable failure).
    // The callable lives in `functions/src/callable/installScheduledJobs.ts`
    // and only succeeds when the caller is an active manager of the
    // stake — the wizard auto-adds the bootstrap admin on first load
    // via `useEnsureBootstrapAdmin`, so this assertion proves the live
    // callable saw a real manager doc + ran without error.
    await expect(page.getByText(/^Setup complete!/i)).toBeVisible({ timeout: 30_000 });
    // No warn-toast about scheduled jobs (the warn variant prefixes
    // "Setup complete, but scheduled jobs could not be enabled" — its
    // absence proves the callable returned ok=true).
    await expect(page.getByText(/scheduled jobs could not be enabled/i)).toHaveCount(0);

    // Second invocation — call the callable directly via the SDK. The
    // wizard has navigated away (setup_complete=true gates it shut), so
    // we cannot click the same button twice; the SDK round-trip is the
    // user-equivalent proof of "callable is safe to retry".
    const second = await invokeCallable<{ ok: boolean }>(page, 'installScheduledJobs', {
      stakeId: STAKE_ID,
    });
    expect(second.ok).toBe(true);
  });
});
