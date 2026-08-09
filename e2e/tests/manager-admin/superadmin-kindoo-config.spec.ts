// A platform superadmin holding NO role on the stake, configuring that
// stake's Home Kindoo Site (`spec.md` §15, T-91).
//
// This is the persona the surface exists for, and it needed three
// layers: active-stake resolution, read access to five sub-collections,
// and a superadmin branch on the parent-stake update. Unit tests mock
// Firestore and rules tests don't render, so this spec is the only
// place all three meet — the first attempt shipped with the save dying
// on `permission-denied`, and the attempt after that with the page
// resolving no active stake at all.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

async function signInAsZeroRoleSuperadmin(page: Page, email: string): Promise<void> {
  await writeDoc('stakes/highplains', {
    stake_name: 'High Plains Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc('stakes/highplains/wards/maple', {
    ward_code: 'maple',
    ward_name: 'Maple',
    building_name: 'Black Forest',
    seat_cap: 30,
  });
  await writeDoc('stakes/highplains/kindooSites/east-stake', {
    id: 'east-stake',
    display_name: 'East Stake (Pine Building)',
    kindoo_expected_site_name: 'East Stake CS',
    kindoo_eid: 555,
  });
  const { uid } = await createAuthUser({ email });
  // Superadmin claim ONLY — no `stakes` block at all.
  await setCustomClaims(uid, { canonical: email, isPlatformSuperadmin: true });
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __KINDOO_TEST__?: unknown }).__KINDOO_TEST__),
  );
  await page.evaluate(
    async (c: { email: string; password: string }) => {
      const hatch = (
        window as unknown as {
          __KINDOO_TEST__: {
            signInWithEmailAndPassword: (e: string, p: string) => Promise<void>;
          };
        }
      ).__KINDOO_TEST__;
      await hatch.signInWithEmailAndPassword(c.email, c.password);
    },
    { email, password: TEST_PASSWORD },
  );
}

test.describe('Zero-role platform superadmin on Kindoo Config (T-91)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('reaches the tab from the Stake List and saves the Home Kindoo Site', async ({ page }) => {
    await signInAsZeroRoleSuperadmin(page, 'sa@example.com');

    // The Stake List row link is the entry point: this identity has no
    // active stake of its own, and only the URL tier of
    // `resolveActiveStake` is permissive for it.
    await page.goto('/superadmin/stakes');
    await page.getByTestId('superadmin-stake-link-highplains').click();
    await expect(page.getByRole('heading', { name: /^Configuration$/ })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId('config-tab-kindoo-sites').click();
    await expect(page.getByTestId('config-home-kindoo-site')).toBeVisible({ timeout: 20_000 });

    // The stake doc resolved — if no active stake had been resolved this
    // reads the em-dash placeholder, which is exactly how the bug showed.
    await expect(page.getByTestId('config-home-site-name')).toHaveText('High Plains Stake');

    // And the foreign site must actually render: a denied `kindooSites`
    // read leaves `data` undefined and prints the EMPTY state, which
    // would tell the operator a site they are about to collide with does
    // not exist.
    await expect(page.getByTestId('config-kindoo-sites-row-east-stake')).toBeVisible();
    await expect(page.getByTestId('config-kindoo-sites-empty')).toHaveCount(0);

    await page.getByTestId('config-home-kindoo-site-edit').click();
    await page.getByTestId('config-home-site-name-input').fill('Black Forest');
    await page.getByTestId('config-home-site-eid-input').fill('27994');
    await page.getByTestId('config-home-kindoo-site-save').click();

    await expect(page.getByTestId('config-home-site-eid')).toHaveText('27994', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('config-home-site-name')).toHaveText('Black Forest');
  });

  test('refuses a home EID that collides with a configured foreign site', async ({ page }) => {
    // The collision guard reads `kindooSites`; before the superadmin
    // read branch that read was denied and the save failed with
    // permission-denied instead of this message.
    await signInAsZeroRoleSuperadmin(page, 'sa2@example.com');
    await page.goto('/manager/configuration?stake=highplains&tab=kindoo-sites');
    await expect(page.getByTestId('config-home-kindoo-site')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('config-home-kindoo-site-edit').click();
    await page.getByTestId('config-home-site-name-input').fill('Black Forest');
    await page.getByTestId('config-home-site-eid-input').fill('555');
    await page.getByTestId('config-home-kindoo-site-save').click();

    await expect(page.locator('.toast-host')).toContainText('East Stake (Pine Building)', {
      timeout: 20_000,
    });
    // A refused save leaves the editor open (the mutation threw, so the
    // close never ran) — which is what we want, the operator can correct
    // the value in place. Cancel out and confirm nothing was written.
    await page.getByTestId('config-home-kindoo-site-cancel').click();
    await expect(page.getByTestId('config-home-site-eid')).toHaveText('Not set');
  });

  test('Wards to Ignore is usable — the wards snapshot is readable', async ({ page }) => {
    // Add is gated on the wards snapshot arriving; a denied read pinned
    // it disabled forever with no explanation.
    await signInAsZeroRoleSuperadmin(page, 'sa3@example.com');
    await page.goto('/manager/configuration?stake=highplains&tab=kindoo-sites');
    await expect(page.getByTestId('config-ignored-wards-add-button')).toBeEnabled({
      timeout: 20_000,
    });
    await page.getByTestId('config-ignored-wards-add-button').click();
    // The own-ward guard proves the wards list actually loaded.
    await page.getByTestId('config-ignored-ward-input').fill('Maple Ward');
    await expect(page.getByTestId('config-ignored-ward-error')).toContainText('one of your own');
  });
});
