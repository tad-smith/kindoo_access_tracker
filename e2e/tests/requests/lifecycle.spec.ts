// End-to-end specs for the request lifecycle's app-driven halves.
//
// The actionable completion / rejection workflow moved to the Chrome
// extension (see `queue-readonly.spec.ts` for the read-only queue), so
// the app no longer drives Mark Complete / Reject. What remains
// app-side and is covered here:
//   1. Bishopric submits add_manual → it appears live on MyRequests +
//      on the manager's (read-only) Request Queue.
//   2. Stake submits add_temp with two buildings → it appears on the
//      manager's queue carrying both buildings + the date range.
//   3. Bishopric submits → cancels from MyRequests → status flips live
//      to cancelled.
//   4. Bishopric clicks Remove on a manual seat → submits → the
//      "removal pending" badge appears live on the roster, and the
//      remove request surfaces on the manager's queue.
//
// Each spec seeds its own data + signs in via the emulator hatch, then
// verifies the user-visible effect end-to-end against a real bundled
// SPA + the local emulator stack. Cloud Functions aren't running in
// this suite (the emulator stack here is firestore + auth only).

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

async function createSignedInUser(
  page: Page,
  email: string,
  claims: Claims,
  startUrl = '/',
): Promise<void> {
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
  await page.goto(startUrl);
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

async function seedBaseStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_id: 'csnorth',
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc('stakes/csnorth/buildings/maple-building', {
    building_id: 'maple-building',
    building_name: 'Maple Building',
    address: '123 Main',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/buildings/cedar-building', {
    building_id: 'cedar-building',
    building_name: 'Cedar Building',
    address: '456 Main',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Maple',
    building_name: 'Maple Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

test.describe('request lifecycle — bishopric add_manual', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric submits → request shows pending on MyRequests and surfaces on the manager queue', async ({
    browser,
  }) => {
    const bishopricCtx = await browser.newContext();
    const bishopricPage = await bishopricCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(bishopricPage, 'bishop@example.com', { wards: ['CO'] }, '/?p=new');
    await expect(bishopricPage.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    // Submit the request.
    await bishopricPage.getByTestId('new-request-email').fill('bob@example.com');
    await bishopricPage.getByTestId('new-request-name').fill('Bob Example');
    await bishopricPage.getByTestId('new-request-reason').fill('Sub Sunday teacher');
    await bishopricPage.getByTestId('new-request-submit').click();
    // Toast confirms submit; navigate to MyRequests to see the row.
    await bishopricPage.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(bishopricPage.locator('[data-status="pending"]').first()).toBeVisible();

    // Manager logs in; the request appears live on the (read-only) queue.
    await createSignedInUser(managerPage, 'manager@example.com', { manager: true });
    await expect(managerPage.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    await expect(managerPage.getByRole('heading', { name: /^Request Queue$/ })).toBeVisible();
    await expect(managerPage.locator('[data-testid^="queue-card-"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(managerPage.getByText('Bob Example')).toBeVisible();
    // Read-only: the queue carries no completion / rejection affordance.
    await expect(managerPage.locator('[data-testid^="queue-complete-"]')).toHaveCount(0);
    await expect(managerPage.locator('[data-testid^="queue-reject-"]')).toHaveCount(0);
  });
});

test.describe('request lifecycle — stake add_temp with two buildings', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('stake submits add_temp with two buildings → both surface on the manager queue with the date range', async ({
    browser,
  }) => {
    const stakeCtx = await browser.newContext();
    const stakePage = await stakeCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(stakePage, 'sp@example.com', { stake: true }, '/?p=new');
    await expect(stakePage.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    await stakePage.getByTestId('new-request-type').selectOption('add_temp');
    await stakePage.getByTestId('new-request-start-date').fill('2026-05-01');
    await stakePage.getByTestId('new-request-end-date').fill('2026-05-08');
    await stakePage.getByTestId('new-request-email').fill('alice@example.com');
    await stakePage.getByTestId('new-request-name').fill('Alice Example');
    await stakePage.getByTestId('new-request-reason').fill('Visiting authority');
    // B-11 — stake-scope defaults every building checked; both Maple
    // and Cedar are pre-ticked, no manual clicks needed for a
    // stake-wide grant.
    await expect(stakePage.getByTestId('new-request-building-maple-building')).toBeChecked();
    await expect(stakePage.getByTestId('new-request-building-cedar-building')).toBeChecked();
    await stakePage.getByTestId('new-request-submit').click();

    // Manager sees the request on the read-only queue, carrying both
    // buildings and the date range.
    await createSignedInUser(managerPage, 'mgr@example.com', { manager: true });
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    const card = managerPage.locator('[data-testid^="queue-card-"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(managerPage.getByText('Alice Example')).toBeVisible();
    await expect(card).toContainText('Maple Building');
    await expect(card).toContainText('Cedar Building');
    await expect(card).toContainText('2026-05-01');
    await expect(card).toContainText('2026-05-08');
    // No action affordances on the read-only queue.
    await expect(managerPage.locator('[data-testid^="queue-complete-"]')).toHaveCount(0);
  });
});

test.describe('request lifecycle — cancel from MyRequests', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric submits → cancels from MyRequests → status flips to cancelled live', async ({
    page,
  }) => {
    await createSignedInUser(page, 'bishop2@example.com', { wards: ['CO'] }, '/?p=new');

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
});

test.describe('request lifecycle — removal flow', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric submits remove → removal-pending badge appears live → request surfaces on the manager queue', async ({
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
      building_names: ['Maple Building'],
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

    // The remove request surfaces on the manager's read-only queue.
    await createSignedInUser(managerPage, 'mgr3@example.com', { manager: true });
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    const card = managerPage.locator('[data-testid^="queue-card-"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(/Remove Access For:/);
    await expect(card).toContainText('Charlie');
    // No completion affordance on the read-only queue.
    await expect(managerPage.locator('[data-testid^="queue-complete-"]')).toHaveCount(0);
  });
});
