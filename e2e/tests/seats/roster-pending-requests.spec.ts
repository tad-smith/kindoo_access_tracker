// E2E coverage for the roster-pending-requests surfaces.
//
// Verifies the two user-visible behaviours operator wants on the
// bishopric / stake roster pages:
//
//   1. Pending ADD for the displayed scope renders an "Outstanding
//      Requests" section below the committed roster, one card per
//      pending add, each tagged with a "Pending" badge.
//   2. Pending REMOVE against an existing committed seat marks that
//      seat's roster card with a "Pending Removal" badge + the
//      light-pink `has-removal-pending` background.
//
// Both effects come from the same live `usePendingRequestsForScope`
// subscription, so a single happy-path spec exercises the wiring.
//
// Bishopric roster covers the ward-scope path; the stake-scope path
// runs through the same component code with `scope='stake'`, covered
// at the unit/component-test layer.

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
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

test.describe('Roster pending requests', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('bishopric roster surfaces a pending add as an Outstanding Requests card with a Pending badge', async ({
    browser,
  }) => {
    const bishopricCtx = await browser.newContext();
    const bishopricPage = await bishopricCtx.newPage();

    await createSignedInUser(bishopricPage, 'bishop-add@example.com', { wards: ['CO'] });
    // Submit the pending add via the New Request page.
    await expect(bishopricPage.getByRole('heading', { name: /^New Request$/ })).toBeVisible();
    await bishopricPage.getByTestId('new-request-email').fill('newhire@example.com');
    await bishopricPage.getByTestId('new-request-name').fill('New Hire');
    await bishopricPage.getByTestId('new-request-reason').fill('Sub Sunday teacher');
    await bishopricPage.getByTestId('new-request-submit').click();

    // Visit the roster — the pending add lands as an Outstanding
    // Requests card, badged Pending.
    await bishopricPage.getByRole('link', { name: /^Ward Roster$/ }).click();
    await expect(bishopricPage.getByTestId('roster-pending-adds-section')).toBeVisible({
      timeout: 10_000,
    });
    await expect(bishopricPage.getByText('New Hire')).toBeVisible();
    await expect(bishopricPage.getByTestId('pending-add-badge').first()).toBeVisible();
  });

  test('bishopric roster marks an existing seat with the Pending Removal badge when a remove is in flight', async ({
    browser,
  }) => {
    // Seed a manual seat so the bishopric has a row to remove.
    await writeDoc('stakes/csnorth/seats/leaving@example.com', {
      member_canonical: 'leaving@example.com',
      member_email: 'leaving@example.com',
      member_name: 'Leaving Soon',
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
    await createSignedInUser(bishopricPage, 'bishop-remove@example.com', { wards: ['CO'] });
    await bishopricPage.getByRole('link', { name: /^Ward Roster$/ }).click();

    // The seat is on the roster.
    await expect(
      bishopricPage.locator('[data-seat-id="leaving@example.com"]').first(),
    ).toBeVisible();

    // Submit the remove request via the per-row affordance.
    await bishopricPage.getByTestId('remove-btn-leaving@example.com').click();
    await bishopricPage.getByTestId('removal-reason').fill('No longer needed');
    await bishopricPage.getByTestId('removal-confirm').click();

    // Live: the row picks up the Pending Removal badge + the
    // has-removal-pending class.
    await expect(
      bishopricPage.getByTestId('pending-removal-badge-leaving@example.com'),
    ).toBeVisible({ timeout: 10_000 });
    const card = bishopricPage.locator('[data-seat-id="leaving@example.com"]');
    await expect(card).toHaveClass(/has-removal-pending/);
  });
});
