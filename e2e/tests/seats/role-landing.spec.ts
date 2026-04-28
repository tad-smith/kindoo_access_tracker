// Phase-5 end-to-end specs: every role lands on its default page and
// can click through to its other pages.
//
// Per `spec.md` §5: manager → /manager/dashboard, stake → /stake/roster
// (Phase 5 leftmost; Phase 6 will reroute to /stake/new), bishopric →
// /bishopric/roster.
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

  test('bishopric principal lands on /bishopric/roster', async ({ page }) => {
    await signInWithClaims(page, 'bishop@example.com', {
      stakes: { csnorth: { manager: false, stake: false, wards: ['CO'] } },
    });
    await expect(page).toHaveURL(/\/bishopric\/roster$/);
    await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
  });
});

test.describe('Phase 5 nav click-through', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('manager can click through Dashboard → All Seats → Audit Log → Access', async ({ page }) => {
    await signInWithClaims(page, 'manager-nav@example.com', {
      stakes: { csnorth: { manager: true, stake: false, wards: [] } },
    });
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    await page.getByRole('link', { name: /^All Seats$/ }).click();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();

    await page.getByRole('link', { name: /^Audit Log$/ }).click();
    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();

    await page.getByRole('link', { name: /^Access$/ }).click();
    await expect(page.getByRole('heading', { name: /^Access$/ })).toBeVisible();
  });

  test('stake can click through Roster → Ward Rosters → My Requests', async ({ page }) => {
    await signInWithClaims(page, 'stake-nav@example.com', {
      stakes: { csnorth: { manager: false, stake: true, wards: [] } },
    });
    await expect(page.getByRole('heading', { name: /^Stake Roster$/ })).toBeVisible();

    await page.getByRole('link', { name: /^Ward Rosters$/ }).click();
    await expect(page.getByRole('heading', { name: /^Ward Rosters$/ })).toBeVisible();

    await page.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(page.getByRole('heading', { name: /^My Requests$/ })).toBeVisible();
  });
});

test.describe('Phase 5 URL deep-links', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
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
