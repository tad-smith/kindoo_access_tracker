// Smoke test for the Phase 7 manager Configuration page. Confirms the
// nav link appears, the route loads, and the per-tab CRUD UI renders.
// Mutation behaviour is tested at the component layer
// (apps/web/src/features/manager/configuration/*.test.tsx) against
// mocked hooks; this proves the route exists and the page renders
// with a real bundle.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  listDocs,
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

async function signInAsManager(page: Page, email: string): Promise<void> {
  // Seed a setup-complete stake so the bootstrap gate is bypassed.
  await writeDoc('stakes/csnorth', {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      csnorth: { manager: true, stake: false, wards: [] },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Manager admin pages (Phase 7)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('manager nav exposes Configuration', async ({ page }) => {
    await signInAsManager(page, 'mgr@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Configuration$/ })).toBeVisible();
  });

  test('Configuration renders the tabs with Buildings before Wards and no calling tabs', async ({
    page,
  }) => {
    await signInAsManager(page, 'mgr-cfg@example.com');
    await page.getByRole('link', { name: /^Configuration$/ }).click();
    await expect(page.getByRole('heading', { name: /^Configuration$/ })).toBeVisible();
    const labels = await page.locator('.kd-config-tab').allTextContents();
    expect(labels).toEqual([
      'Config',
      'Managers',
      'Kindoo Config',
      'Buildings',
      'Wards',
      'Organizations',
    ]);
    // The Organizations tab sits last and is clickable.
    await expect(page.getByTestId('config-tab-organizations')).toBeVisible();
    // The Auto Ward / Stake Callings tabs are gone.
    await expect(page.getByTestId('config-tab-ward-callings')).toHaveCount(0);
    await expect(page.getByTestId('config-tab-stake-callings')).toHaveCount(0);
  });

  test('Config tab shows the Elders Quorum President opt-in, off for a stake that never set it', async ({
    page,
  }) => {
    // `eq_president_app_access` is opt-in: the seeded stake doc omits it,
    // so the switch must render off against a real bundle.
    await signInAsManager(page, 'mgr-eq@example.com');
    await page.goto('/manager/configuration?tab=config');
    const sw = page.getByTestId('config-eq-president-access');
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  test('Configuration deep-link to ?tab=managers lands on the Managers panel', async ({ page }) => {
    await signInAsManager(page, 'mgr-cfg2@example.com');
    await page.goto('/manager/configuration?tab=managers');
    await expect(page.getByRole('heading', { name: /Kindoo Managers/i })).toBeVisible();
  });

  test('Wards tab blocks Add Ward and hints to add a building first when none exist', async ({
    page,
  }) => {
    await signInAsManager(page, 'mgr-wards@example.com');
    await page.goto('/manager/configuration?tab=wards');
    await expect(page.getByTestId('config-wards-add-button')).toBeDisabled();
    await expect(page.getByTestId('config-wards-no-buildings-hint')).toContainText(
      'Add a building first',
    );
  });

  test('Wards tab enables Add Ward once a building exists', async ({ page }) => {
    await signInAsManager(page, 'mgr-wards2@example.com');
    await writeDoc('stakes/csnorth/buildings/maple-building', {
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      lastActor: { email: 'seed@example.com', canonical: 'seed@example.com' },
    });
    await page.goto('/manager/configuration?tab=wards');
    await expect(page.getByTestId('config-wards-add-button')).toBeEnabled();
    await expect(page.getByTestId('config-wards-no-buildings-hint')).toHaveCount(0);
  });

  test('editing a building name keeps the slug doc; does not orphan it (T-67)', async ({
    page,
  }) => {
    // Core defect this PR fixes: renaming a building must write the SAME
    // doc (slug frozen), not create a new doc under the re-slugged name.
    await signInAsManager(page, 'mgr-bldg-rename@example.com');
    await writeDoc('stakes/csnorth/buildings/maple-building', {
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      lastActor: { email: 'seed@example.com', canonical: 'seed@example.com' },
    });
    await page.goto('/manager/configuration?tab=buildings');
    await page.getByTestId('config-building-edit-maple-building').click();
    await page.getByLabel(/^Name$/).fill('Oak Building');
    await page.getByTestId('config-building-submit').click();

    // The row keeps the same testid (slug 'maple-building'), now showing
    // the new display name. No 'oak-building' row exists — the slug never
    // re-derived, so the doc was updated in place rather than orphaned.
    const list = page.getByTestId('config-buildings-list');
    await expect(list.getByText('Oak Building')).toBeVisible();
    await expect(page.getByTestId('config-building-edit-maple-building')).toBeVisible();
    await expect(page.getByTestId('config-building-edit-oak-building')).toHaveCount(0);
  });

  test('renaming a building rewrites its wards’ building_name and backfills a legacy ward’s building_id (T-74)', async ({
    page,
  }) => {
    // Wards are written through by the rename, not blocked by it. This
    // runs through the real rules, so it also proves a manager may
    // update ward docs as part of the building save — a denial would
    // roll back the whole transaction and leave the building renamed
    // nowhere.
    await signInAsManager(page, 'mgr-bldg-wards@example.com');
    const stamp = {
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      lastActor: { email: 'seed@example.com', canonical: 'seed@example.com' },
    };
    await writeDoc('stakes/csnorth/buildings/maple-building', {
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      ...stamp,
    });
    await writeDoc('stakes/csnorth/buildings/pine-building', {
      building_id: 'pine-building',
      building_name: 'Pine Building',
      address: '456 Pine',
      ...stamp,
    });
    // Slug-bearing ward — only its display-name snapshot goes stale.
    await writeDoc('stakes/csnorth/wards/CO', {
      ward_code: 'CO',
      ward_name: 'Maple 1st',
      building_id: 'maple-building',
      building_name: 'Maple Building',
      seat_cap: 20,
      ...stamp,
    });
    // Legacy ward — name is its ONLY reference, so the rename would
    // orphan it outright.
    await writeDoc('stakes/csnorth/wards/LG', {
      ward_code: 'LG',
      ward_name: 'Maple 2nd',
      building_name: 'Maple Building',
      seat_cap: 20,
      ...stamp,
    });
    // A different building's ward — must not be touched.
    await writeDoc('stakes/csnorth/wards/PN', {
      ward_code: 'PN',
      ward_name: 'Pine 1st',
      building_id: 'pine-building',
      building_name: 'Pine Building',
      seat_cap: 20,
      ...stamp,
    });

    await page.goto('/manager/configuration?tab=buildings');
    await page.getByTestId('config-building-edit-maple-building').click();
    await page.getByLabel(/^Name$/).fill('Oak Building');
    await page.getByTestId('config-building-submit').click();
    await expect(page.getByTestId('config-buildings-list').getByText('Oak Building')).toBeVisible();

    // Assert on what actually landed in Firestore — the UI resolves a
    // ward's building id-first, so it would render the new name even if
    // the snapshot were still stale.
    await expect
      .poll(async () => {
        const wards = await listDocs('stakes/csnorth/wards');
        return Object.fromEntries(
          wards.map((w) => [w['__id__'], [w['building_id'], w['building_name']]]),
        );
      })
      .toEqual({
        CO: ['maple-building', 'Oak Building'],
        LG: ['maple-building', 'Oak Building'], // building_id backfilled
        PN: ['pine-building', 'Pine Building'], // untouched
      });
  });

  test('blocks a building rename that collides with another building name (T-67)', async ({
    page,
  }) => {
    await signInAsManager(page, 'mgr-bldg-dup@example.com');
    await writeDoc('stakes/csnorth/buildings/maple-building', {
      building_id: 'maple-building',
      building_name: 'Maple Building',
      address: '123 Main',
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      lastActor: { email: 'seed@example.com', canonical: 'seed@example.com' },
    });
    await writeDoc('stakes/csnorth/buildings/pine-building', {
      building_id: 'pine-building',
      building_name: 'Pine Building',
      address: '456 Pine',
      created_at: new Date().toISOString(),
      last_modified_at: new Date().toISOString(),
      lastActor: { email: 'seed@example.com', canonical: 'seed@example.com' },
    });
    await page.goto('/manager/configuration?tab=buildings');
    await page.getByTestId('config-building-edit-maple-building').click();
    await page.getByLabel(/^Name$/).fill('Pine Building');
    await page.getByTestId('config-building-submit').click();

    await expect(page.getByText(/Building names must be unique/i)).toBeVisible();
    // The original building name is unchanged in the list.
    await expect(
      page.getByTestId('config-buildings-list').getByText('Maple Building'),
    ).toBeVisible();
  });
});
