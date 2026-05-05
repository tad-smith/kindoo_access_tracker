// Happy-path E2E for the role-aware collapsible buildings selector
// on /new. A single-ward bishopric submitter:
//   - Lands on the form and sees the buildings widget collapsed with
//     their ward's building (Cordera) listed in the header summary.
//   - Expands the widget and ticks an additional building (Genoa).
//   - Submits the request.
//   - The manager opens the Mark Complete dialog and sees BOTH
//     buildings pre-checked from the requester's selection — proof
//     the second building flowed through to Firestore.
//
// The legacy form did not let ward users select multiple buildings;
// this spec is the regression-guard against losing that capability.

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

test.describe('New Request — collapsible buildings selector', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('ward submitter starts collapsed with the ward building, expands, adds Genoa, and the manager sees both pre-checked', async ({
    browser,
  }) => {
    const bishopricCtx = await browser.newContext();
    const bishopricPage = await bishopricCtx.newPage();
    const managerCtx = await browser.newContext();
    const managerPage = await managerCtx.newPage();

    await createSignedInUser(bishopricPage, 'bishop-multi@example.com', { wards: ['CO'] });
    await expect(bishopricPage.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    // Header summary shows the default ward building, panel collapsed.
    const trigger = bishopricPage.getByTestId('new-request-buildings-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(bishopricPage.getByTestId('new-request-buildings-summary')).toContainText(
      'Building: Cordera Building',
    );

    // Expand → tick Genoa as an additional building.
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(bishopricPage.getByTestId('new-request-building-cordera-building')).toBeChecked();
    await bishopricPage.getByTestId('new-request-building-genoa-building').click();
    await expect(bishopricPage.getByTestId('new-request-buildings-summary')).toContainText(
      'Buildings: Cordera Building, Genoa Building',
    );

    // Fill the rest of the form. The Genoa pick is cross-ward for a CO
    // bishop, so the comment is required to clear the cross-ward gate.
    await bishopricPage.getByTestId('new-request-email').fill('multi@example.com');
    await bishopricPage.getByTestId('new-request-name').fill('Multi Member');
    await bishopricPage.getByTestId('new-request-reason').fill('Sub teacher');
    await bishopricPage
      .getByTestId('new-request-comment')
      .fill('Helping a member from the next ward over.');
    await bishopricPage.getByTestId('new-request-submit').click();

    // Bishopric MyRequests shows the row pending.
    await bishopricPage.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(bishopricPage.locator('[data-status="pending"]').first()).toBeVisible();

    // Manager completes — both buildings pre-checked from submission.
    await createSignedInUser(managerPage, 'mgr-multi@example.com', { manager: true });
    await managerPage.getByRole('link', { name: /^Request Queue$/ }).click();
    const completeButton = managerPage.locator('[data-testid^="queue-complete-"]').first();
    await completeButton.click();
    await expect(
      managerPage.locator('[data-testid="complete-building-cordera-building"]'),
    ).toBeChecked();
    await expect(
      managerPage.locator('[data-testid="complete-building-genoa-building"]'),
    ).toBeChecked();
  });
});
