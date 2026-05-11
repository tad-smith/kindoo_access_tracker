// Regression coverage for the cross-scope read bug: a user with
// stake-level access plus bishopric of one ward must be able to load
// the Ward Rosters page for a DIFFERENT ward (one outside their
// bishopric claim) and see that ward's seats. Pre-fix the seats
// listener errored with permission-denied because the rule restricted
// stake-scope members to only stake-scope seats.
//
// Setup mirrors `seats/role-landing.spec.ts` + `seats/roster-pending-
// requests.spec.ts`: synthetic Auth user, custom claims stamped
// directly (the claim-sync trigger is bypassed under
// KINDOO_SKIP_CLAIM_SYNC), Firestore pre-seeded via the emulator REST
// fixture. Two wards seeded (CO + GE), a seat per ward; the user has
// stake-level access and bishopric of CO only; the spec navigates to
// `/stake/wards?ward=GE` and asserts the GE seat row renders without
// any permission-denied surface.

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

async function seedStakeAndWards(): Promise<void> {
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_id: STAKE_ID,
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    callings_sheet_id: 'sheet1',
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/cordera-building`, {
    building_id: 'cordera-building',
    building_name: 'Cordera Building',
    address: '123 Main',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  // Two wards: CO (the user holds bishopric here) and GE (the user
  // does NOT hold bishopric here). The bug surfaces when viewing GE.
  await writeDoc(`stakes/${STAKE_ID}/wards/CO`, {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc(`stakes/${STAKE_ID}/wards/GE`, {
    ward_code: 'GE',
    ward_name: 'Gleneagle',
    building_name: 'Cordera Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  // One seat in each ward so the page renders a row regardless of
  // which ward the user picks.
  await writeDoc(`stakes/${STAKE_ID}/seats/co-member@example.com`, {
    member_canonical: 'co-member@example.com',
    member_email: 'co-member@example.com',
    member_name: 'CO Member',
    scope: 'CO',
    type: 'manual',
    callings: [],
    reason: 'sub teacher',
    building_names: ['Cordera Building'],
    duplicate_grants: [],
    granted_by_request: 'seed-co',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/ge-member@example.com`, {
    member_canonical: 'ge-member@example.com',
    member_email: 'ge-member@example.com',
    member_name: 'GE Member',
    scope: 'GE',
    type: 'manual',
    callings: [],
    reason: 'sub teacher',
    building_names: ['Cordera Building'],
    duplicate_grants: [],
    granted_by_request: 'seed-ge',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

async function signInAsStakePlusBishopric(
  page: Page,
  email: string,
  bishopricWards: string[],
): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      [STAKE_ID]: { manager: false, stake: true, wards: bishopricWards },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Stake user reading a ward roster outside their bishopric', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedStakeAndWards();
  });

  // Captures Firestore SDK permission-denied errors that the SPA logs to
  // the console (the listener error surfaces there even when the page
  // renders gracefully). Treat any console error mentioning the
  // permission-denied code as a hard failure for this regression spec.
  test('Ward Rosters page shows seats for a ward outside the bishopric claim', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await signInAsStakePlusBishopric(page, 'stake-plus-co@example.com', ['CO']);

    // Deep-link to the GE ward via the route's `?ward=` search param —
    // the operator-reported flow.
    await page.goto('/stake/wards?ward=GE');

    await expect(page.getByRole('heading', { name: /^Ward Rosters$/ })).toBeVisible();

    // The GE seat row renders (proves the listener resolved without a
    // permission-denied error). Locator is the data-seat-id attribute
    // emitted by RosterCardList.
    await expect(page.locator('[data-seat-id="ge-member@example.com"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('GE Member')).toBeVisible();

    // Defensive: the empty-state fallback ("No seats in Gleneagle yet.")
    // must NOT appear — the rule fix flipped this from an empty result
    // (or an error) to a populated listener.
    await expect(page.getByText(/No seats in .* yet\./)).toHaveCount(0);

    // No permission-denied error fired into the console while the page
    // was reading the GE-scope seat. This is the load-bearing assertion
    // for the regression: pre-fix this listener errored with
    // `permission-denied` and the message bubbled to console.error
    // (firestore SDK logs listener errors at error level).
    const permErrors = consoleErrors.filter((m) =>
      /permission[-_ ]denied|Missing or insufficient permissions/i.test(m),
    );
    expect(permErrors).toEqual([]);
  });

  // Sanity check: the user's OWN bishopric ward still renders (existing
  // ward branch was not broken by the fix).
  test('Ward Rosters page still shows seats for the user-bishopric ward', async ({ page }) => {
    await signInAsStakePlusBishopric(page, 'stake-plus-co-sanity@example.com', ['CO']);
    await page.goto('/stake/wards?ward=CO');
    await expect(page.getByRole('heading', { name: /^Ward Rosters$/ })).toBeVisible();
    await expect(page.locator('[data-seat-id="co-member@example.com"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('CO Member')).toBeVisible();
  });
});
