// E2E for the URL-tier of the active-stake selector (spec §2.1).
// Asserts:
//   - `/manager/dashboard?stake=ridgeline` lands the SPA on the
//     ridgeline stake (the SPA reads the param, persists it to both
//     storage tiers, and strips it from the URL).
//   - After first render the URL bar shows no `?stake=X` (the
//     `history.replaceState` strip ran).
//   - sessionStorage AND localStorage both carry the deep-linked
//     stake.
//
// Setup: two stakes (csnorth + ridgeline), one user holding manager on
// both. Direct nav into the manager dashboard with the deep-link param;
// asserts the brand bar surfaces ridgeline's stake_name and the URL has
// been cleaned up.

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

async function signInAsManagerOnBothStakes(page: Page, email: string): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      csnorth: { manager: true, stake: false, wards: [] },
      ridgeline: { manager: true, stake: false, wards: [] },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Active-stake URL deep-link (?stake=X)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedStake('csnorth', 'CS North Stake');
    await seedStake('ridgeline', 'Ridgeline Stake');
  });

  test('?stake=ridgeline lands the SPA on ridgeline, persists storage, strips URL', async ({
    page,
  }) => {
    await signInAsManagerOnBothStakes(page, 'multi-stake@example.com');

    // Navigate directly to the deep-link URL.
    await page.goto('/manager/dashboard?stake=ridgeline');

    // Brand bar surfaces the ridgeline stake_name once the doc loads.
    await expect(page.locator('.kd-brandbar-stake')).toContainText('Ridgeline Stake', {
      timeout: 10_000,
    });

    // URL has been cleaned up — no `?stake=X` survives.
    await expect.poll(async () => page.url()).not.toMatch(/stake=ridgeline/);

    // Both storage tiers carry the deep-linked stake.
    const sessionValue = await page.evaluate(() =>
      window.sessionStorage.getItem('kindoo.activeStake'),
    );
    const localValue = await page.evaluate(() => window.localStorage.getItem('kindoo.activeStake'));
    expect(sessionValue).toBe('ridgeline');
    expect(localValue).toBe('ridgeline');
  });

  test('/manager/queue?focus=…&stake=… consumes both params (push-tap deep link)', async ({
    page,
  }) => {
    // Push-notification deep-link target: per the SW notificationclick
    // bridge, a tapped push lands on `/manager/queue?focus=<requestId>&stake=<stakeId>`.
    // Without `stake: z.string().optional()` on the queue route's
    // searchSchema, TanStack Router would strip the unknown `stake`
    // param before our `useActiveStake` consumer could read it.
    await signInAsManagerOnBothStakes(page, 'queue-focus@example.com');

    await page.goto('/manager/queue?focus=req-123&stake=ridgeline');

    // Brand bar shows ridgeline (proves the stake param survived to
    // `useActiveStake` rather than being canonicalised away).
    await expect(page.locator('.kd-brandbar-stake')).toContainText('Ridgeline Stake', {
      timeout: 10_000,
    });

    // `?stake=` is consumed and stripped by the active-stake hook.
    await expect.poll(async () => page.url()).not.toMatch(/stake=ridgeline/);

    // Both storage tiers carry the deep-linked stake (spec §2.1
    // URL-tier success path writes session AND local).
    const sessionValue = await page.evaluate(() =>
      window.sessionStorage.getItem('kindoo.activeStake'),
    );
    const localValue = await page.evaluate(() => window.localStorage.getItem('kindoo.activeStake'));
    expect(sessionValue).toBe('ridgeline');
    expect(localValue).toBe('ridgeline');
  });
});
