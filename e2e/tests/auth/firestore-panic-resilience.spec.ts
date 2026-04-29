// Resilience specs for the Firestore-SDK-panic mitigation. The DIY
// hooks at `apps/web/src/lib/data/` and the `RootErrorBoundary` in
// `apps/web/src/components/` together guarantee that a permission-denied
// snapshot — even one that triggers the SDK 12.x `Unexpected state ID:
// ca9 / b815` internal-assertion panic — never leaves the user staring
// at a blank page.
//
// Two assertions per scenario:
//   1. The SPA renders a usable page (NotAuthorized / SetupInProgress /
//      etc.), not the boundary fallback. The fallback is the last-line
//      catch; we want the hook-error path to do the work in the common
//      case.
//   2. The boundary's `data-testid="root-error-boundary"` element is
//      NEVER visible during the flow. If it appears, the SDK panicked
//      and our defensive layers leaked.

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

test.describe('Firestore SDK panic resilience', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('no-claims user against a setup-complete stake hits permission-denied without crashing', async ({
    page,
  }) => {
    // Stake doc with `setup_complete=true` means the rules' read predicate
    // collapses to `isAnyMember(stakeId)`, which a no-claims user fails.
    // The SPA's gate-stake-doc subscription receives `permission-denied`
    // on its initial connect — historically the input to the SDK panic.
    // The expected post-fix outcome: the gate sees `stake.status ===
    // 'error'` and routes to NotAuthorized; the boundary never renders.
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: true,
    });
    await createAuthUser({ email: 'panic-noclaims@example.com' });

    // Capture browser console output so we can assert the operator-
    // visible log line appears with the expected Firestore path.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await signInViaTestHatch(page, 'panic-noclaims@example.com', TEST_PASSWORD);

    // Sensible page rendered — not the boundary fallback.
    await expect(page.getByRole('heading', { name: /Not authorized/i })).toBeVisible();
    await expect(page.getByTestId('root-error-boundary')).toHaveCount(0);

    // The hook should have logged the failing path. The matching console
    // message includes the path and the `permission-denied` code so
    // operators can grep staging.
    const hookErrorSeen = consoleErrors.some(
      (txt) => txt.includes('[useFirestoreDoc]') && txt.includes('stakes/csnorth'),
    );
    expect(hookErrorSeen).toBe(true);
  });

  test('non-admin user during setup-in-progress lands on SetupInProgress without crashing', async ({
    page,
  }) => {
    // Stake doc with `setup_complete=false` and `bootstrap_admin_email`
    // pointing at someone else. The setup-in-progress read gate
    // (`isSetupInProgressReadable`) lets the gate read the stake doc;
    // the user lands on SetupInProgress. The boundary must not fire even
    // though a snapshot listener is in flight against a partially-
    // permitted set of paths.
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: false,
    });
    await createAuthUser({ email: 'panic-nonadmin@example.com' });

    await page.goto('/');
    await signInViaTestHatch(page, 'panic-nonadmin@example.com', TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: /Setup in progress/i })).toBeVisible();
    await expect(page.getByTestId('root-error-boundary')).toHaveCount(0);
  });
});
