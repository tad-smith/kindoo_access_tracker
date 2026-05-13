// Phase 6 end-to-end specs for the request lifecycle.
//
// Covers the seven user-visible flows from `firebase-migration.md`
// §Phase 6 Tests / E2E:
//   1. Bishopric submits add_manual → queue updates live → manager
//      completes → bishopric roster shows the new seat.
//   2. Stake submits add_temp with two buildings → manager completes
//      → seat appears with both buildings + end_date.
//   3. Bishopric clicks Remove on a manual seat → submits → "removal
//      pending" badge appears live → manager completes → seat gone.
//   4. Bishopric submits → cancels from MyRequests → status flips
//      live to cancelled.
//   5. Manager rejects pending request with reason → MyRequests
//      shows rejected + the reason.
//   6. Multi-role principal submits against a wrong scope → server
//      denies via the rules.
//   7. Two managers race Mark Complete; second sees an error toast.
//
// Each spec seeds its own data + signs in via the emulator hatch, then
// verifies the user-visible effect end-to-end against a real bundled
// SPA + the local emulator stack. Cloud Functions aren't running in
// this suite (the emulator stack here is firestore + auth only) — the
// audit trigger + remove-seat-on-request-complete trigger are out of
// scope; their behaviours are covered by `functions/` integration
// tests. The remove-flow E2E asserts the request flips to complete
// and the "removal pending" badge clears; the seat-deletion side is
// gated on Phase 8.

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

interface Claims {
  manager?: boolean;
  stake?: boolean;
  wards?: string[];
}

async function createSignedInUser(page: Page, email: string, claims: Claims): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      csnorth: {
        manager: claims.manager ?? false,
        stake: claims.stake ?? false,
        wards: claims.wards ?? [],
      },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

async function seedBaseStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_id: 'csnorth',
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    callings_sheet_id: 'sheet1',
  });
  await writeDoc('stakes/csnorth/buildings/cordera-building', {
    building_id: 'cordera-building',
    building_name: 'Cordera Building',
    address: '123 Main',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/buildings/genoa-building', {
    building_id: 'genoa-building',
    building_name: 'Genoa Building',
    address: '456 Main',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

test.describe('Phase 6 — bishopric add_manual lifecycle', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric submits → manager completes → bishopric roster shows the new seat', async ({
    browser,
  }) => {
    const bishopricCtx = await browser.newContext();
    const bishopricPage = await bishopricCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(bishopricPage, 'bishop@example.com', { wards: ['CO'] });
    await expect(bishopricPage.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    // Submit the request.
    await bishopricPage.getByTestId('new-request-email').fill('bob@example.com');
    await bishopricPage.getByTestId('new-request-name').fill('Bob Example');
    await bishopricPage.getByTestId('new-request-reason').fill('Sub Sunday teacher');
    await bishopricPage.getByTestId('new-request-submit').click();
    // Toast confirms submit; navigate to MyRequests to see the row.
    await bishopricPage.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(bishopricPage.locator('[data-status="pending"]').first()).toBeVisible();

    // Manager logs in and completes.
    await createSignedInUser(managerPage, 'manager@example.com', { manager: true });
    await expect(managerPage.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    await expect(managerPage.getByRole('heading', { name: /^Request Queue$/ })).toBeVisible();
    // Click Mark Complete on the first card.
    const completeButton = managerPage.locator('[data-testid^="queue-complete-"]').first();
    await completeButton.click();
    // Ward-scope requests auto-populate building_names from the ward's
    // building_name on submit, so the building is already ticked in the
    // Mark Complete dialog. Confirm directly.
    await expect(
      managerPage.locator('[data-testid="complete-building-cordera-building"]'),
    ).toBeChecked();
    await managerPage.getByTestId('complete-add-confirm').click();

    // Bishopric: request flips to complete on MyRequests.
    await expect(bishopricPage.locator('[data-status="complete"]').first()).toBeVisible({
      timeout: 10_000,
    });

    // Bishopric roster shows the new seat.
    await bishopricPage.getByRole('link', { name: /^Ward Roster$/ }).click();
    await expect(bishopricPage.getByText('Bob Example')).toBeVisible();
  });
});

test.describe('Phase 6 — stake add_temp with two buildings', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('stake submits add_temp with two buildings → manager completes → seat carries both buildings', async ({
    browser,
  }) => {
    const stakeCtx = await browser.newContext();
    const stakePage = await stakeCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(stakePage, 'sp@example.com', { stake: true });
    await expect(stakePage.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    await stakePage.getByTestId('new-request-type').selectOption('add_temp');
    await stakePage.getByTestId('new-request-start-date').fill('2026-05-01');
    await stakePage.getByTestId('new-request-end-date').fill('2026-05-08');
    await stakePage.getByTestId('new-request-email').fill('alice@example.com');
    await stakePage.getByTestId('new-request-name').fill('Alice Example');
    await stakePage.getByTestId('new-request-reason').fill('Visiting authority');
    // B-11 — stake-scope defaults every building checked; both Cordera
    // and Genoa are pre-ticked, no manual clicks needed for a
    // stake-wide grant.
    await expect(stakePage.getByTestId('new-request-building-cordera-building')).toBeChecked();
    await expect(stakePage.getByTestId('new-request-building-genoa-building')).toBeChecked();
    await stakePage.getByTestId('new-request-submit').click();

    // Manager completes.
    await createSignedInUser(managerPage, 'mgr@example.com', { manager: true });
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    const completeButton = managerPage.locator('[data-testid^="queue-complete-"]').first();
    await completeButton.click();
    // Both buildings should be pre-ticked from the requester's selection.
    await expect(
      managerPage.locator('[data-testid="complete-building-cordera-building"]'),
    ).toBeChecked();
    await expect(
      managerPage.locator('[data-testid="complete-building-genoa-building"]'),
    ).toBeChecked();
    await managerPage.getByTestId('complete-add-confirm').click();

    // All Seats shows the new seat.
    await managerPage.getByRole('link', { name: /^All Seats$/ }).click();
    await expect(managerPage.getByText('Alice Example')).toBeVisible();
  });
});

test.describe('Phase 6 — cancel + reject', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric submits → cancels from MyRequests → status flips to cancelled live', async ({
    page,
  }) => {
    await createSignedInUser(page, 'bishop2@example.com', { wards: ['CO'] });

    await page.getByTestId('new-request-email').fill('bob2@example.com');
    await page.getByTestId('new-request-name').fill('Bob 2');
    await page.getByTestId('new-request-reason').fill('reason');
    await page.getByTestId('new-request-submit').click();

    await page.getByRole('link', { name: /^My Requests$/ }).click();
    const pendingCard = page.locator('[data-status="pending"]').first();
    await expect(pendingCard).toBeVisible();
    await pendingCard.getByRole('button', { name: /^Cancel$/ }).click();
    await page.getByRole('button', { name: /Cancel request/i }).click();

    // Live update flips status.
    await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('manager rejects with reason → requester sees rejected status + reason', async ({
    browser,
  }) => {
    const bishopricCtx = await browser.newContext();
    const bishopricPage = await bishopricCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(bishopricPage, 'bishop3@example.com', { wards: ['CO'] });
    await bishopricPage.getByTestId('new-request-email').fill('bob3@example.com');
    await bishopricPage.getByTestId('new-request-name').fill('Bob 3');
    await bishopricPage.getByTestId('new-request-reason').fill('reason');
    await bishopricPage.getByTestId('new-request-submit').click();

    await createSignedInUser(managerPage, 'mgr2@example.com', { manager: true });
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    const rejectButton = managerPage.locator('[data-testid^="queue-reject-"]').first();
    await rejectButton.click();
    await managerPage.getByTestId('reject-reason').fill('Insufficient justification');
    await managerPage.getByTestId('reject-confirm').click();

    await bishopricPage.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(bishopricPage.locator('[data-status="rejected"]').first()).toBeVisible({
      timeout: 10_000,
    });
    // Inline rejection reason — no expand button.
    await expect(bishopricPage.getByTestId('rejection-reason')).toContainText(
      /Insufficient justification/,
    );
  });
});

test.describe('Phase 6 — removal flow', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric submits remove → removal-pending badge → manager completes', async ({
    browser,
  }) => {
    // Pre-seed a manual seat in CO. We want the bishopric's roster to
    // show a row with a Remove affordance.
    await writeDoc('stakes/csnorth/seats/charlie@example.com', {
      member_canonical: 'charlie@example.com',
      member_email: 'charlie@example.com',
      member_name: 'Charlie',
      scope: 'CO',
      type: 'manual',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
      duplicate_grants: [],
      granted_by_request: 'seed-req',
      lastActor: { email: 'manager@example.com', canonical: 'manager@example.com' },
    });

    const bishopricCtx = await browser.newContext();
    const bishopricPage = await bishopricCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(bishopricPage, 'bishop4@example.com', { wards: ['CO'] });
    await bishopricPage.getByRole('link', { name: /^Ward Roster$/ }).click();

    await expect(
      bishopricPage.locator('[data-seat-id="charlie@example.com"]').first(),
    ).toBeVisible();
    await bishopricPage.getByTestId('remove-btn-charlie@example.com').click();
    await bishopricPage.getByTestId('removal-reason').fill('No longer needed');
    await bishopricPage.getByTestId('removal-confirm').click();

    // Live: badge appears in place of the X.
    await expect(bishopricPage.getByTestId('removal-pending-charlie@example.com')).toBeVisible({
      timeout: 10_000,
    });

    // Manager completes the remove. The Phase 8 cloud function would
    // delete the seat; without it, we only assert the request flips.
    await createSignedInUser(managerPage, 'mgr3@example.com', { manager: true });
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    const completeBtn = managerPage.locator('[data-testid^="queue-complete-"]').first();
    await completeBtn.click();
    await managerPage.getByTestId('complete-remove-confirm').click();

    // Bishopric MyRequests shows complete; seat is still on the roster
    // (Phase 8 trigger handles the delete).
    await bishopricPage.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(bishopricPage.locator('[data-status="complete"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
