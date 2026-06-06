// E2E for the brand-bar stake-switcher dropdown (spec §2.1).
// Asserts:
//   - A user with roles on ≥ 2 stakes sees the trigger.
//   - Clicking a stake-list item swaps the active stake without leaving
//     the page; the brand bar updates and storage tiers reflect the
//     choice.
//   - A user with exactly one accessible stake does NOT see the
//     trigger.

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

async function seedStake(stakeId: string, displayName: string): Promise<void> {
  await writeDoc(`stakes/${stakeId}`, {
    stake_name: displayName,
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    timezone: 'America/Denver',
    notifications_enabled: true,
  });
}

async function signInAsManagerOnStakes(
  page: Page,
  email: string,
  stakeIds: string[],
): Promise<void> {
  const { uid } = await createAuthUser({ email });
  const stakes: Record<string, { manager: boolean; stake: boolean; wards: string[] }> = {};
  for (const sid of stakeIds) {
    stakes[sid] = { manager: true, stake: false, wards: [] };
  }
  await setCustomClaims(uid, { canonical: email, stakes });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Stake switcher dropdown', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedStake('csnorth', 'CS North Stake');
    await seedStake('ridgeline', 'Ridgeline Stake');
  });

  test('renders the switcher and swaps active stake on item click', async ({ page }) => {
    await signInAsManagerOnStakes(page, 'two-stakes@example.com', ['csnorth', 'ridgeline']);
    await page.goto('/manager/dashboard');

    // Switcher trigger is visible for a principal with ≥ 2 stakes.
    const trigger = page.getByTestId('stake-switcher-trigger');
    await expect(trigger).toBeVisible({ timeout: 10_000 });

    // Default active stake is alphabetically-first (csnorth) — the
    // brand bar shows its stake_name.
    await expect(page.locator('.kd-brandbar-stake')).toContainText('CS North Stake');

    // Open the menu and click ridgeline.
    await trigger.click();
    await page.getByTestId('stake-switcher-item-ridgeline').click();

    // Brand bar updates to ridgeline.
    await expect(page.locator('.kd-brandbar-stake')).toContainText('Ridgeline Stake', {
      timeout: 10_000,
    });

    // Both storage tiers reflect the choice.
    const sessionValue = await page.evaluate(() =>
      window.sessionStorage.getItem('kindoo.activeStake'),
    );
    const localValue = await page.evaluate(() => window.localStorage.getItem('kindoo.activeStake'));
    expect(sessionValue).toBe('ridgeline');
    expect(localValue).toBe('ridgeline');
  });

  test('hides the switcher for a user with exactly one accessible stake', async ({ page }) => {
    await signInAsManagerOnStakes(page, 'one-stake@example.com', ['csnorth']);
    await page.goto('/manager/dashboard');

    // Brand bar renders, switcher trigger does not.
    await expect(page.locator('.kd-brandbar-stake')).toContainText('CS North Stake', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('stake-switcher-trigger')).toHaveCount(0);
  });
});
