// End-to-end tests for the Manager Import-Now flow (Phase 8 §1094 +
// T-25). Drives the live `runImportNow` callable through the local
// Functions emulator: signs in as a kindooManager, seeds Firestore with
// stake / wards / templates / Sheets fixture, clicks "Import Now," and
// asserts the page surfaces the success summary plus the over-cap
// banner reactively as the importer writes back to the stake doc.
//
// The Sheets fetcher running inside the emulator is the
// Firestore-doc-backed `emulatorSheetFetcher` defined in
// `functions/src/lib/sheets.ts`; tests seed `_e2eFixtures/sheets__{sheetId}`
// via the `seedSheetFixture` helper before each callable invocation.
//
// Two paths are covered:
//   1. Happy path → status updates with insert / update / delete counts.
//   2. Over-cap path → `last_over_caps_json` populates and the SPA banner
//      surfaces; subsequent clean run clears the banner reactively.
//
// Component-level tests in `apps/web/src/features/manager/import/` cover
// rendering edge cases (loading state, error toast wording, etc.); this
// spec is the live-callable proof.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  seedSheetFixture,
  setCustomClaims,
  writeDoc,
  type SheetFixtureTab,
} from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';
const STAKE_ID = 'csnorth';
const SHEET_ID = 'sheet-fixture';
const HEADER_ROW = ['Organization', 'Forwarding Email', 'Position', 'Name', 'Personal Email'];

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

interface ManagerSeedOpts {
  stakeSeatCap?: number;
  callingsSheetId?: string;
  /** Override the per-ward seat cap (default 20). Lowering this is the
   * easiest way to drive a ward-over-cap scenario from a fixture with N
   * CO-scope rows. */
  wardSeatCap?: number;
}

/**
 * Seed a setup-complete stake plus one ward + one building + the
 * minimal calling templates that the importer needs to map a "CO Bishop"
 * row to a seat. Mirrors the integration-test seed at
 * `functions/tests/Importer.test.ts:seedStake` so the importer's
 * runtime sees the same shape it does in unit tests.
 */
async function seedStake(opts: ManagerSeedOpts = {}): Promise<void> {
  const stakeSeatCap = opts.stakeSeatCap ?? 100;
  const callingsSheetId = opts.callingsSheetId ?? SHEET_ID;
  const wardSeatCap = opts.wardSeatCap ?? 20;
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_id: STAKE_ID,
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: stakeSeatCap,
    callings_sheet_id: callingsSheetId,
    expiry_hour: 3,
    import_day: 'MONDAY',
    import_hour: 4,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
  });
  await writeDoc(`stakes/${STAKE_ID}/wards/CO`, {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'Cordera Building',
    seat_cap: wardSeatCap,
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/cordera-building`, {
    building_id: 'cordera-building',
    building_name: 'Cordera Building',
    address: '',
  });
  await writeDoc(`stakes/${STAKE_ID}/wardCallingTemplates/Bishop`, {
    calling_name: 'Bishop',
    give_app_access: true,
    auto_kindoo_access: true,
    sheet_order: 1,
  });
}

async function signInAsManager(page: Page, email: string): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await writeDoc(`stakes/${STAKE_ID}/kindooManagers/${email}`, {
    member_canonical: email,
    member_email: email,
    name: email,
    active: true,
  });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      [STAKE_ID]: { manager: true, stake: false, wards: [] },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Manager Import Now (live Functions emulator)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('clicking Import Now invokes runImportNow and renders the summary', async ({ page }) => {
    await seedStake();
    const tabs: SheetFixtureTab[] = [
      {
        name: 'CO',
        values: [HEADER_ROW, ['CO', '', 'CO Bishop', 'Alice Smith', 'alice@gmail.com']],
      },
    ];
    await seedSheetFixture(SHEET_ID, tabs);
    await signInAsManager(page, 'mgr-import@example.com');

    await page.getByRole('link', { name: /^Import$/ }).click();
    await expect(page.getByRole('heading', { name: /^Import$/ })).toBeVisible();
    await expect(page.getByTestId('import-callings-sheet-id')).toHaveText(SHEET_ID);

    await page.getByTestId('import-now-button').click();

    // Summary card lands once the callable resolves; first run inserts
    // exactly one row (Alice -> CO Bishop). Bump the timeout above the
    // Playwright default — Functions emulator cold start can take a
    // beat the first time the callable is invoked in a session.
    const summary = page.getByTestId('import-summary');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(summary).toHaveAttribute('data-summary-status', 'ok');
    await expect(page.getByTestId('import-summary-inserted')).toHaveText('1');
    await expect(page.getByTestId('import-summary-deleted')).toHaveText('0');
    await expect(page.getByTestId('import-summary-updated')).toHaveText('0');

    // Live stake-doc subscription updates `last_import_summary` once
    // the importer commits its writeStakeImportSummary step. The
    // formatter pluralises ("1 insert", "0 deletes", ...); match the
    // singular form for the one insert this fixture produces.
    await expect(page.getByTestId('import-last-summary')).toContainText(/1 insert\b/);
    // No over-cap pools at stake_seat_cap=100; banner stays hidden.
    await expect(page.getByTestId('import-over-cap-banner')).toHaveCount(0);
  });

  test('over-cap pool surfaces the banner; clean rerun clears it', async ({ page }) => {
    // Tight ward seat_cap of 1 → three CO-scope rows over-cap the ward
    // pool. The banner reports the CO ward; we assert it appears, then
    // re-seed the fixture as empty and re-run — the importer's three
    // deletes empty `last_over_caps_json` and the banner disappears.
    await seedStake({ wardSeatCap: 1 });
    const tabs: SheetFixtureTab[] = [
      {
        name: 'CO',
        values: [
          HEADER_ROW,
          ['CO', '', 'CO Bishop', 'Member Zero', 'm0@gmail.com'],
          ['CO', '', 'CO Bishop', 'Member One', 'm1@gmail.com'],
          ['CO', '', 'CO Bishop', 'Member Two', 'm2@gmail.com'],
        ],
      },
    ];
    await seedSheetFixture(SHEET_ID, tabs);
    await signInAsManager(page, 'mgr-overcap@example.com');

    await page.getByRole('link', { name: /^Import$/ }).click();
    await page.getByTestId('import-now-button').click();

    // Importer succeeds (LCR truth wins) but writes the over-cap
    // snapshot. The summary card surfaces 3 inserts; the banner
    // appears reactively as the stake-doc subscription updates.
    await expect(page.getByTestId('import-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-summary-inserted')).toHaveText('3');

    const banner = page.getByTestId('import-over-cap-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Over-cap warning/i);
    // The CO ward pool over-caps by 2 (three Bishops, cap=1). The page
    // emits a per-pool row keyed by pool ID.
    await expect(page.getByTestId('import-over-cap-row-CO')).toBeVisible();

    // Clear the fixture so the second run produces zero inserts and
    // empties `last_over_caps_json`. Three deletes drop the prior run's
    // seats; over_caps clears reactively in the SPA.
    await seedSheetFixture(SHEET_ID, [{ name: 'CO', values: [HEADER_ROW] }]);
    await page.getByTestId('import-now-button').click();

    await expect(page.getByTestId('import-summary-deleted')).toHaveText('3', { timeout: 30_000 });
    // Banner disappears once `last_over_caps_json` is `[]`.
    await expect(page.getByTestId('import-over-cap-banner')).toHaveCount(0);
  });
});
