// E2E for B-3: the New Request scope dropdown is filtered by the
// principal's role union for the stake. The unit + component tests
// cover every row in the spec table; this suite exercises two
// representative cases end to end:
//
//   1. Stake-only user signs in → the form collapses to a static
//      "Requesting for: Stake" line, no dropdown rendered.
//   2. Single-ward bishopric user signs in → the form collapses to
//      "Requesting for: Ward CO", and BA does NOT appear anywhere
//      in the form (no leak from the wards catalogue).

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
  // Two wards seeded so we can prove the dropdown filter holds even
  // when the wards catalogue carries entries the user does NOT hold.
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/wards/BA', {
    ward_code: 'BA',
    ward_name: 'Banning',
    building_name: 'Cordera Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

test.describe('B-3 — New Request scope filter mirrors the principal role union', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('stake-only user: scope dropdown is suppressed; form shows "Requesting for: Stake"', async ({
    page,
  }) => {
    await createSignedInUser(page, 'stake-only@example.com', { stake: true });
    await expect(page.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    // Static label rather than a dropdown. The "Requesting for:" prefix
    // is in a <strong> child of the .kd-page-subtitle div; the scope
    // label sits as a sibling text node, so we assert against the form
    // root (which contains both).
    await expect(page.getByTestId('new-request-scope')).toHaveCount(0);
    const form = page.getByTestId('new-request-form');
    await expect(form).toContainText(/Requesting for:/i);
    await expect(form).toContainText(/Stake/i);

    // The stake user should NOT see any ward option text in the page,
    // even though wards CO + BA exist in the catalogue.
    const formText = (await form.textContent()) ?? '';
    expect(formText).not.toMatch(/Ward CO/);
    expect(formText).not.toMatch(/Ward BA/);
  });

  test('single-ward bishopric user: scope dropdown is suppressed; only the held ward is offered', async ({
    page,
  }) => {
    await createSignedInUser(page, 'bishop-co@example.com', { wards: ['CO'] });
    await expect(page.getByRole('heading', { name: /^New Request$/ })).toBeVisible();

    await expect(page.getByTestId('new-request-scope')).toHaveCount(0);
    const form = page.getByTestId('new-request-form');
    await expect(form).toContainText(/Requesting for:/i);
    await expect(form).toContainText(/Ward CO/);

    // BA is in the catalogue but NOT in the user role union — must not
    // surface in the form anywhere.
    const formText = (await form.textContent()) ?? '';
    expect(formText).not.toMatch(/Ward BA/);
    // And no stake option either — the form's "Requesting for:" prefix
    // would be followed by "Stake" if it surfaced, so a Stake substring
    // is the proxy.
    expect(formText).not.toMatch(/Stake/i);
  });
});
