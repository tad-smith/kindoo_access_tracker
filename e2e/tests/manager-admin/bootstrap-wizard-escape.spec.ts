// Regression coverage for a PR #258 reviewer finding: the StakeSwitcher
// lets a manager of stake A discover and click into bootstrap-only
// stake B's "Setup needed" badge, but `BootstrapWizardPage` rendered
// outside `<Shell>` with no way back — no nav, no StakeSwitcher, no
// sign-out. Selecting B persists the choice to BOTH sessionStorage and
// localStorage, so the user was stuck until they either finished B's
// entire setup or cleared site data (the operator's own account shape:
// manager of one stake, also the named bootstrap admin of a new one).
//
// The fix adds an escape bar to the wizard itself:
//   - "Back to my stake(s)" when the principal has other claim-derived
//     access — switches the active stake (overwriting both storage
//     tiers, same as the StakeSwitcher's own click handler) and routes
//     home.
//   - "Sign out" — always present; the only way out for a pure
//     bootstrap admin with no other accessible stake.
//
// Two tests: (1) the "other stakes" case, reached via the real
// StakeSwitcher "Setup needed" click (the actual repro path), proving
// the way-back does not bounce back into the wizard even after a full
// page reload; (2) the pure-bootstrap-admin case, where only sign-out
// renders and it actually signs the user out.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';
const SCREENSHOT_PATH = 'test-results/bootstrap-wizard-escape-bar.png';

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

test.describe('Bootstrap wizard escape bar', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('a manager with another accessible stake can get back to it, and reload does not bounce back into the wizard', async ({
    page,
  }) => {
    const adminEmail = 'dual-role-admin@example.com';

    // Stake the admin already manages — fully set up.
    await writeDoc('stakes/csnorth', {
      stake_name: 'North Stake',
      bootstrap_admin_email: 'someone-else@example.com',
      setup_complete: true,
      stake_seat_cap: 25,
    });
    // A second, brand-new stake the same admin is the bootstrap admin
    // of — not yet set up. This is what puts "Setup needed" on the
    // StakeSwitcher.
    await writeDoc('stakes/newstake', {
      stake_name: 'New Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
      stake_seat_cap: 0,
    });

    const { uid } = await createAuthUser({ email: adminEmail });
    await writeDoc(`stakes/csnorth/kindooManagers/${adminEmail}`, {
      email: adminEmail,
      active: true,
    });
    await setCustomClaims(uid, {
      canonical: adminEmail,
      stakes: {
        csnorth: { manager: true, stake: false, wards: [] },
        newstake: { manager: false, stake: false, wards: [], bootstrap: true },
      },
    });

    await page.goto('/');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    // Default landing: the only claim-derived stake (csnorth).
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Reproduce the actual PR #258 path into the wizard: open the
    // switcher and click the bootstrap-only "Setup needed" stake.
    await page.getByTestId('stake-switcher-trigger').click();
    await expect(page.getByTestId('stake-switcher-setup-badge-newstake')).toBeVisible();
    await page.getByTestId('stake-switcher-item-newstake').click();

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Set up Stake Building Access/i }),
    ).toBeVisible();

    const backButton = page.getByTestId('wizard-escape-back-to-stakes');
    const signOutButton = page.getByTestId('wizard-escape-sign-out');
    await expect(backButton).toBeVisible();
    await expect(backButton).toHaveText(/Back to my stake/i);
    await expect(signOutButton).toBeVisible();

    // Capture both escape affordances in frame.
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

    await backButton.click();

    // Landed back on North Stake's Dashboard — not stuck in the wizard.
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    await expect(page.getByTestId('bootstrap-wizard')).toHaveCount(0);

    // The critical assertion: the choice was PERSISTED (not just an
    // in-memory nav), so a fresh page load doesn't resolve straight
    // back into New Stake's wizard.
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    await expect(page.getByTestId('bootstrap-wizard')).toHaveCount(0);
  });

  test('a pure bootstrap admin with no other accessible stake sees only sign-out, and it works', async ({
    page,
  }) => {
    const adminEmail = 'pure-bootstrap-admin@example.com';
    await writeDoc('stakes/onlystake', {
      stake_name: 'Only Stake',
      bootstrap_admin_email: adminEmail,
      setup_complete: false,
      stake_seat_cap: 0,
    });
    const { uid } = await createAuthUser({ email: adminEmail });
    await setCustomClaims(uid, { canonical: adminEmail, stakes: {} });

    // Zero claim-derived stakes — the resolver needs the `?stake=`
    // hint the same way the pre-existing bootstrap-wizard.spec.ts tests
    // do (no accessible-stake fallback to derive it from).
    await page.goto('/?stake=onlystake');
    await signInViaTestHatch(page, adminEmail, TEST_PASSWORD);

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await expect(page.getByTestId('wizard-escape-back-to-stakes')).toHaveCount(0);

    const signOutButton = page.getByTestId('wizard-escape-sign-out');
    await expect(signOutButton).toBeVisible();
    await signOutButton.click();

    // Back on SignInPage — the only way out for a wrong-account signin.
    await expect(page.getByRole('button', { name: /Send me a sign-in link/i })).toBeVisible();
  });
});
