// End-to-end spec: a Kindoo Manager may create a request in ANY scope
// without holding a separate `access` row.
//
// The user under test holds only `stakes.csnorth.manager === true` — no
// `stake: true`, no bishopric wards, and no `access/{email}` doc. That
// principal previously had no submit surface at all; now the manager
// claim alone carries request authority over the stake scope and every
// ward.
//
// The spec drives the hardest case: Ward Rosters, picking a ward the
// manager holds no bishopric claim for, opening the New Request modal
// from the page header, and submitting. Success is verified against the
// real Firestore rules (the create must be ALLOWED server-side) by the
// request landing live on My Requests carrying that ward's scope.

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

/**
 * Sign in a user whose ONLY claim in the stake is `manager: true` —
 * explicitly no stake membership and no bishopric wards, and no
 * `access/{canonical}` doc seeded anywhere.
 */
async function signInManagerOnly(page: Page, email: string, startUrl = '/'): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: { csnorth: { manager: true, stake: false, wards: [] } },
  });
  await page.goto(startUrl);
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

async function seedBaseStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
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
  await writeDoc('stakes/csnorth/wards/GE', {
    ward_code: 'GE',
    ward_name: 'Cedar',
    building_name: 'Cedar Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

test.describe('manager-only user requests in any scope', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('manager with no access row submits a ward-scope request from Ward Rosters for a ward they hold no bishopric claim for', async ({
    page,
  }) => {
    await signInManagerOnly(page, 'mgr-any-scope@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Ward Rosters — the manager's cross-ward surface.
    await page.goto('/stake/wards?ward=GE');
    await expect(page.getByRole('heading', { name: /^Ward Rosters$/ })).toBeVisible();

    // The New Request affordance renders for a ward the manager holds no
    // bishopric claim for.
    const newRequest = page.getByTestId('ward-rosters-new-request');
    await expect(newRequest).toBeVisible();
    await newRequest.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('new-request-form')).toBeVisible();
    await dialog.getByTestId('new-request-email').fill('dana@example.com');
    await dialog.getByTestId('new-request-name').fill('Dana Example');
    await dialog.getByTestId('new-request-reason').fill('Ward activity coordinator');
    await dialog.getByTestId('new-request-submit').click();

    // Rules ALLOWED the create: the request lands live on My Requests
    // carrying the GE ward scope. A denied write would leave the dialog
    // open with an error toast and no row here.
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await page.goto('/my-requests');
    const card = page.locator('[data-status="pending"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Dana Example');
    await expect(card).toContainText('Cedar');
  });

  test('manager with no access row submits a stake-scope request from the Stake Roster', async ({
    page,
  }) => {
    await signInManagerOnly(page, 'mgr-stake-scope@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    await page.goto('/stake/roster');
    await expect(page.getByRole('heading', { name: /^Stake Roster$/ })).toBeVisible();

    const newRequest = page.getByTestId('stake-roster-new-request');
    await expect(newRequest).toBeVisible();
    await newRequest.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('new-request-form')).toBeVisible();
    await dialog.getByTestId('new-request-email').fill('erin@example.com');
    await dialog.getByTestId('new-request-name').fill('Erin Example');
    await dialog.getByTestId('new-request-reason').fill('Stake choir director');
    await dialog.getByTestId('new-request-submit').click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await page.goto('/my-requests');
    const card = page.locator('[data-status="pending"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Erin Example');
  });

  test('manager with no access row removes a ward-scope seat from Ward Rosters', async ({
    page,
  }) => {
    await writeDoc('stakes/csnorth/seats/frank@example.com', {
      member_canonical: 'frank@example.com',
      member_email: 'frank@example.com',
      member_name: 'Frank Example',
      scope: 'GE',
      type: 'manual',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cedar Building'],
      duplicate_grants: [],
      granted_by_request: 'seed-req',
      lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
    });

    await signInManagerOnly(page, 'mgr-remove@example.com');
    await page.goto('/stake/wards?ward=GE');
    await expect(page.locator('[data-seat-id="frank@example.com"]').first()).toBeVisible();

    // Remove + Edit both render on a ward the manager holds no
    // bishopric claim for.
    await expect(page.getByTestId('edit-btn-frank@example.com')).toBeVisible();

    // Mobile viewport (375px) keeps both row controls reachable.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByTestId('edit-btn-frank@example.com')).toBeVisible();
    await expect(page.getByTestId('remove-btn-frank@example.com')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByTestId('remove-btn-frank@example.com').click();
    await page.getByTestId('removal-reason').fill('No longer needed');
    await page.getByTestId('removal-confirm').click();

    // The dialog only closes once `setDoc` is acknowledged by the
    // server, so this is the real rules verdict. Asserting the badge
    // alone would not be: Firestore surfaces the pending local mutation
    // to `onSnapshot` before the backend rejects it, so a denied write
    // still flashes the badge for a moment.
    await expect(page.getByTestId('removal-dialog-form')).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId('removal-pending-frank@example.com')).toBeVisible({
      timeout: 10_000,
    });
  });
});
