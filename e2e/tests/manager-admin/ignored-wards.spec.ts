// Wards to Ignore in Kindoo — the last list on the Kindoo Config tab.
// Validation and mutation payloads are covered at the component layer
// (ConfigurationPage.test.tsx); this proves the section renders in a
// real bundle and that a write round-trips through Firestore rules to
// the parent stake doc.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

async function signInAsManager(page: Page, email: string): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc('stakes/csnorth/wards/maple', {
    ward_code: 'maple',
    ward_name: 'Maple',
    building_name: 'Maple Building',
    seat_cap: 30,
  });
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: { csnorth: { manager: true, stake: false, wards: [] } },
  });
  await page.goto('/');
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
    { email, password: TEST_PASSWORD },
  );
}

test.describe('Wards to Ignore in Kindoo', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('adds a ward, persists it to the stake doc, and removes it again', async ({ page }) => {
    // Every assertion here that follows a navigation gets a generous
    // timeout. The list renders off a Firestore snapshot, and a
    // navigation (first load or the reload below) has to establish the
    // websocket before one arrives — warm that is ~1s, but on the first
    // test after a cold `vite preview` build it intermittently exceeded
    // the 5s default. Timing, not behaviour: the same test passes 6/6
    // once the server is warm.
    await signInAsManager(page, 'mgr-ignored@example.com');
    await page.goto('/manager/configuration?tab=kindoo-sites');

    await expect(page.getByRole('heading', { name: 'Wards to Ignore in Kindoo' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('config-ignored-wards-empty')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('config-ignored-wards-add-button').click();

    // A pasted description is refused — matching is on the ward name alone.
    await page.getByTestId('config-ignored-ward-input').fill('Aspen Grove Ward (Bishop)');
    await expect(page.getByTestId('config-ignored-ward-error')).toContainText(
      'drop the calling in parentheses',
    );

    // Our own ward is refused — ignoring it would hide its own Sync rows.
    await page.getByTestId('config-ignored-ward-input').fill('Maple Ward');
    await expect(page.getByTestId('config-ignored-ward-error')).toContainText('one of your own');

    // A neighbouring stake's ward goes through and survives a reload.
    await page.getByTestId('config-ignored-ward-input').fill('Aspen Grove Ward');
    await expect(page.getByTestId('config-ignored-ward-error')).toHaveCount(0);
    await page.getByTestId('config-ignored-ward-submit').click();
    await expect(page.getByTestId('config-ignored-ward-row-Aspen Grove Ward')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('config-ignored-ward-row-Aspen Grove Ward')).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId('config-ignored-ward-delete-Aspen Grove Ward').click();
    await expect(page.getByTestId('config-ignored-wards-empty')).toBeVisible();
  });
});
