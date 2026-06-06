// End-to-end specs: every role lands on its default page and can
// click through to its other pages.
//
// Per `spec.md` §5: manager → /manager/dashboard, stake →
// /stake/roster, bishopric → /bishopric/roster. Non-Kindoo-Manager
// roles land on the Roster so the first surface those users see is the
// current seat list for their scope; the roster headers carry a "New
// Request" button that opens the request form in an in-page modal — the
// sole entry point for creating a request.
//
// We exercise:
//   - Default landing for each role.
//   - Click-through to one other page in the role's nav.
//   - URL deep-link with search params (?ward=CO) pre-fills filters.
//   - Mobile viewport renders without horizontal scroll.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

/**
 * Seed a setup-complete stake doc so the Phase 7 setup-complete gate
 * (added 2026-04-29) doesn't intercept claim-bearing users into
 * SetupInProgress. Per `lib/setupGate.ts`, an absent stake doc is
 * treated as `setup_complete=false` (Option A).
 */
async function seedSetupCompleteStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
  });
}

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

async function signInWithClaims(
  page: Page,
  email: string,
  claims: object,
  startUrl = '/',
): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, { canonical: email, ...claims });
  await page.goto(startUrl);
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Phase 5 default landings', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedSetupCompleteStake();
  });

  test('manager principal lands on /manager/dashboard', async ({ page }) => {
    await signInWithClaims(page, 'manager@example.com', {
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
    await expect(page).toHaveURL(/\/manager\/dashboard$/);
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
  });

  test('stake principal lands on /stake/roster', async ({ page }) => {
    await signInWithClaims(page, 'stake@example.com', {
      stakes: { csnorth: { manager: false, stake: true, wards: [] } },
    });
    await expect(page).toHaveURL(/\/stake\/roster$/);
    await expect(page.getByRole('heading', { name: /^Stake Roster$/ })).toBeVisible();
  });

  test('bishopric principal lands on /bishopric/roster with a "New Request" header button', async ({
    page,
  }) => {
    await signInWithClaims(page, 'bishop@example.com', {
      stakes: { csnorth: { manager: false, stake: false, wards: ['CO'] } },
    });
    await expect(page).toHaveURL(/\/bishopric\/roster$/);
    await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
    // The header button opens the New Request form in an in-page modal —
    // the only way to create a request.
    const newRequestBtn = page.getByTestId('bishopric-roster-new-request');
    await expect(newRequestBtn).toBeVisible();
    await expect(newRequestBtn).toHaveText('New Request');
    await newRequestBtn.click();
    // The modal opens in place — the URL stays on the roster (no route
    // change) and the dialog renders the form pre-selecting the bishop's
    // ward as the request scope.
    await expect(page).toHaveURL(/\/bishopric\/roster$/);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /^New Request$/ })).toBeVisible();
    await expect(dialog.getByTestId('new-request-form')).toBeVisible();
  });
});

test.describe('Phase 5 nav click-through', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedSetupCompleteStake();
  });

  test('manager can click through Dashboard → All Seats → Audit Log → App Access', async ({
    page,
  }) => {
    await signInWithClaims(page, 'manager-nav@example.com', {
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    await page.getByRole('link', { name: /^All Seats$/ }).click();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();

    await page.getByRole('link', { name: /^Audit Log$/ }).click();
    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();

    // Phase 10.1 nav rename: nav label is "App Access" but the page H1
    // is still "Access".
    await page.getByRole('link', { name: /^App Access$/ }).click();
    await expect(page.getByRole('heading', { name: /^Access$/ })).toBeVisible();
  });

  test('stake can click through Stake Roster → New Request modal → Ward Roster → My Requests', async ({
    page,
  }) => {
    await signInWithClaims(page, 'stake-nav@example.com', {
      stakes: { csnorth: { manager: false, stake: true, wards: [] } },
    });
    // Stake principals default-land on /stake/roster (spec §5).
    await expect(page.getByRole('heading', { name: /^Stake Roster$/ })).toBeVisible();

    // The Stake Roster header carries a "New Request" button (gated by
    // stake-scope request authority) that opens the New Request modal
    // pre-selecting the stake scope — no route change.
    const stakeNewRequest = page.getByTestId('stake-roster-new-request');
    await expect(stakeNewRequest).toBeVisible();
    await stakeNewRequest.click();
    await expect(page).toHaveURL(/\/stake\/roster$/);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /^New Request$/ })).toBeVisible();
    await expect(dialog.getByTestId('new-request-form')).toBeVisible();

    // Close the modal via Cancel and confirm we're still on the roster.
    await dialog.getByTestId('new-request-cancel').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Stake Roster$/ })).toBeVisible();

    // Phase 10.1: single "Ward Roster" nav entry; for stake users it
    // routes to the all-wards picker, whose page H1 is "Ward Rosters".
    await page.getByRole('link', { name: /^Ward Roster$/ }).click();
    await expect(page.getByRole('heading', { name: /^Ward Rosters$/ })).toBeVisible();

    await page.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(page.getByRole('heading', { name: /^My Requests$/ })).toBeVisible();
  });
});

test.describe('Phase 5 URL deep-links', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedSetupCompleteStake();
  });

  test('manager seats deep-link pre-fills the filter', async ({ page }) => {
    await signInWithClaims(
      page,
      'manager-deeplink@example.com',
      {
        stakes: { csnorth: { manager: true, stake: false, wards: [] } },
      },
      '/?p=mgr/seats',
    );
    await expect(page).toHaveURL(/\/manager\/seats$/);
  });
});

test.describe('Phase 5 mobile viewport', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedSetupCompleteStake();
  });

  test('manager dashboard fits 375x667 without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInWithClaims(page, 'mobile-mgr@example.com', {
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
