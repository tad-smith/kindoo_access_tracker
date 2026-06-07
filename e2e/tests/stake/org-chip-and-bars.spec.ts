// Visual coverage for the Stake Roster's two organization surfaces:
//
//   1. The per-card ORGANIZATION CHIP — a neutral-grey Badge-style pill
//      (matching the seat-type chip beside it) with a ▾ caret on the
//      editable variant. A stake user (`stake: true`) sees it editable.
//   2. The per-organization UTILIZATION BARS below the stake bar, each
//      with its NAME in a left cell ("Stake Total" / the org names) and
//      the count on the right.
//
// Seeds a stake, a building, one organization ("High Council", cap 8),
// and one stake seat assigned to that org; signs in as a stake user;
// loads /stake/roster; asserts both surfaces render; then captures a
// screenshot to a stable path (`e2e/test-results/org-chip-and-bars.png`)
// so the operator can eyeball the chip + bars.
//
// Setup mirrors `stake/cross-scope-roster-read.spec.ts`: synthetic Auth
// user, custom claims stamped directly (KINDOO_SKIP_CLAIM_SYNC),
// Firestore pre-seeded via the emulator REST fixture.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';
const STAKE_ID = 'csnorth';
const SCREENSHOT_PATH = 'test-results/org-chip-and-bars.png';

const ACTOR = { email: 'admin@example.com', canonical: 'admin@example.com' };

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

async function seedStakeWithOrg(): Promise<void> {
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_name: 'Test Stake',
    bootstrap_admin_email: ACTOR.email,
    setup_complete: true,
    stake_seat_cap: 25,
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/stake-center`, {
    building_id: 'stake-center',
    building_name: 'Stake Center',
    address: '1 Stake Way',
    lastActor: ACTOR,
  });
  // One organization with a small display-only cap so the per-org bar
  // shows a meaningful fill (1 / 8).
  await writeDoc(`stakes/${STAKE_ID}/organizations/high-council`, {
    organization_id: 'high-council',
    name: 'High Council',
    seat_cap: 8,
    lastActor: ACTOR,
  });
  // One stake seat assigned to that org → the card's org chip resolves
  // to "High Council" and the per-org bar counts 1.
  await writeDoc(`stakes/${STAKE_ID}/seats/member@example.com`, {
    member_canonical: 'member@example.com',
    member_email: 'member@example.com',
    member_name: 'Jane Smith',
    scope: 'stake',
    type: 'manual',
    callings: [],
    reason: 'High council clerk',
    building_names: ['Stake Center'],
    duplicate_grants: [],
    organization_id: 'high-council',
    granted_by_request: 'seed-1',
    lastActor: ACTOR,
  });
}

async function signInAsStakeUser(page: Page, email: string): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    // `stake: true` → the org chip renders editable (with the ▾ caret).
    stakes: { [STAKE_ID]: { manager: false, stake: true, wards: [] } },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Stake Roster — organization chip + per-org utilization bars', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedStakeWithOrg();
  });

  test('renders the org chip on a card and the per-org bars, and captures a screenshot', async ({
    page,
  }) => {
    await signInAsStakeUser(page, 'stake-org@example.com');

    // Stake users default-land on /stake/roster (spec §5).
    await expect(page.getByRole('heading', { name: /^Stake Roster$/ })).toBeVisible();

    // The seeded seat's card renders.
    await expect(page.locator('[data-seat-id="member@example.com"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Jane Smith')).toBeVisible();

    // (1) The org chip resolves to "High Council" and is the editable
    //     pill (carries the overlaid native select + ▾ caret).
    const chip = page.getByTestId('org-chip-member@example.com');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('High Council');
    await expect(chip).toHaveAttribute('data-editable', 'true');
    await expect(page.getByTestId('org-select-member@example.com')).toBeAttached();

    // (2) The per-org utilization bars: "Stake Total" + "High Council"
    //     names in the LEFT cells, counts on the right.
    const nameCells = page.locator('.kd-roster-utilization .utilization-name');
    await expect(nameCells.filter({ hasText: 'Stake Total' })).toHaveCount(1);
    await expect(nameCells.filter({ hasText: 'High Council' })).toHaveCount(1);
    // Counts (un-prefixed) sit in their own right-side cells.
    await expect(
      page.locator('.kd-roster-utilization .utilization-label', { hasText: '1 / 25 seats used' }),
    ).toBeVisible();
    await expect(
      page.locator('.kd-roster-utilization .utilization-label', { hasText: '1 / 8 seats used' }),
    ).toBeVisible();

    // Capture the roster (chip + bars both in frame) to a stable path.
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  });
});
