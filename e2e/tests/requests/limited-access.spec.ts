// E2E coverage for LIMITED app access (D24) — the narrowing flag a
// stake claim carries as `stakes[sid].limited`. A limited user keeps
// their bishopric role but loses authority over the durable seat types:
//
//   - they may create `add_temp` requests only (never `add_manual`),
//   - the temp window is capped at 90 days,
//   - a ward-scope request is locked to the ward's own building,
//   - they may edit / remove `temp` seats only.
//
// The claim is seeded directly rather than driven through the access-doc
// → `syncAccessClaims` trigger: the e2e stack runs the Functions
// emulator with `KINDOO_SKIP_CLAIM_SYNC=true`, so a trigger-written
// claim would never land. `setCustomClaims` takes the whole claims
// object, which is the same shape the trigger mints.
//
// The final test is the regression guard that matters most: a
// NON-limited bishopric in the same ward, against the same seeded data,
// must see the form and roster exactly as before. Every narrowing above
// is keyed off one boolean; the control case is what proves the boolean
// is actually being read rather than the narrowing being unconditional.

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
const STAKE_ID = 'csnorth';
const WARD = 'CO';
const WARD_BUILDING = 'Maple Building';
const OTHER_BUILDING = 'Cedar Building';

// Temp-window boundary. `2026-09-01 → 2026-11-30` is exactly 90 whole
// days (the cap allows it); `2026-12-01` is 91 (the cap rejects it).
// Fixed calendar dates, not `Date.now()` offsets, so the spec asserts
// the same boundary on every run.
const TEMP_START = '2026-09-01';
const TEMP_END_90_DAYS = '2026-11-30';
const TEMP_END_91_DAYS = '2026-12-01';

const TEMP_WINDOW_ERROR = 'Temporary access is limited to 90 days.';

const actor = (email: string) => ({ email, canonical: email });

async function signInViaTestHatch(page: Page, email: string): Promise<void> {
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

interface Claims {
  manager?: boolean;
  stake?: boolean;
  wards?: string[];
  /** D24 — narrows an existing role; absent / false = full access. */
  limited?: boolean;
}

async function createSignedInUser(
  page: Page,
  email: string,
  claims: Claims,
  startUrl = '/',
): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      [STAKE_ID]: {
        manager: claims.manager ?? false,
        stake: claims.stake ?? false,
        wards: claims.wards ?? [],
        // Only stamp the flag when it's on — the trigger's normalised
        // block never carries `limited: false`.
        ...(claims.limited === true ? { limited: true } : {}),
      },
    },
  });
  await page.goto(startUrl);
  await signInViaTestHatch(page, email);
}

/** Stake + two buildings + one ward whose building is Maple. */
async function seedBaseStake(): Promise<void> {
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/maple-building`, {
    building_id: 'maple-building',
    building_name: WARD_BUILDING,
    address: '123 Main',
    lastActor: actor('admin@example.com'),
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/cedar-building`, {
    building_id: 'cedar-building',
    building_name: OTHER_BUILDING,
    address: '456 Main',
    lastActor: actor('admin@example.com'),
  });
  await writeDoc(`stakes/${STAKE_ID}/wards/${WARD}`, {
    ward_code: WARD,
    ward_name: 'Maple',
    building_name: WARD_BUILDING,
    seat_cap: 20,
    lastActor: actor('admin@example.com'),
  });
}

const AUTO_SEAT = 'auto.member@example.com';
const MANUAL_SEAT = 'manual.member@example.com';
const TEMP_SEAT = 'temp.member@example.com';

/**
 * One seat of each type in the ward, so a single roster render shows an
 * auto row, a manual row, and a temp row together. The Edit / Remove
 * affordances are per-row, so all three must be present in one view for
 * the presence/absence assertions to mean anything.
 */
async function seedWardRosterWithEachSeatType(): Promise<void> {
  const now = new Date('2026-08-01T17:00:00Z');
  const base = {
    scope: WARD,
    callings: [] as string[],
    duplicate_grants: [],
    duplicate_scopes: [],
    created_at: now,
    last_modified_at: now,
    last_modified_by: actor('manager@example.com'),
    lastActor: actor('manager@example.com'),
    building_names: [WARD_BUILDING],
  };

  await writeDoc(`stakes/${STAKE_ID}/seats/${AUTO_SEAT}`, {
    ...base,
    member_canonical: AUTO_SEAT,
    member_email: AUTO_SEAT,
    member_name: 'Auto Member',
    type: 'auto',
    callings: ['Bishop'],
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/${MANUAL_SEAT}`, {
    ...base,
    member_canonical: MANUAL_SEAT,
    member_email: MANUAL_SEAT,
    member_name: 'Manual Member',
    type: 'manual',
    reason: 'Building scheduler',
    granted_by_request: 'seed-req-manual',
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/${TEMP_SEAT}`, {
    ...base,
    member_canonical: TEMP_SEAT,
    member_email: TEMP_SEAT,
    member_name: 'Temp Member',
    type: 'temp',
    reason: 'Youth conference setup',
    start_date: TEMP_START,
    end_date: '2026-09-15',
    granted_by_request: 'seed-req-temp',
  });
}

/** Open the New Request modal from the bishopric roster header. */
async function openNewRequestDialog(page: Page) {
  await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
  await page.getByTestId('bishopric-roster-new-request').click();
  // Select by accessible name — a Radix popover inside the form also
  // carries role="dialog", so the bare role is ambiguous.
  const dialog = page.getByRole('dialog', { name: 'New Request' });
  await expect(dialog.getByTestId('new-request-form')).toBeVisible();
  return dialog;
}

test.describe('Limited app access (D24)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('offers Temporary as the only request type and defaults to it for a limited ward submitter', async ({
    page,
  }) => {
    await createSignedInUser(page, 'limited-bishop@example.com', {
      wards: [WARD],
      limited: true,
    });
    const dialog = await openNewRequestDialog(page);

    const typeSelect = dialog.getByTestId('new-request-type');
    // Temporary is both the only option and the mounted default — a
    // limited user can never even express `add_manual`.
    await expect(typeSelect.locator('option')).toHaveCount(1);
    await expect(typeSelect.locator('option')).toHaveText(['Temporary (dated)']);
    await expect(typeSelect).toHaveValue('add_temp');

    // Temporary being the default means the dated fields and the
    // 90-day cap notice are on screen without the user touching anything.
    await expect(dialog.getByTestId('new-request-temp-cap-hint')).toHaveText(TEMP_WINDOW_ERROR);
    await expect(dialog.getByTestId('new-request-start-date')).toBeVisible();
    await expect(dialog.getByTestId('new-request-end-date')).toBeVisible();
  });

  test("locks the building to the ward's own building with no checklist for a limited ward submitter", async ({
    page,
  }) => {
    await createSignedInUser(page, 'limited-bishop@example.com', {
      wards: [WARD],
      limited: true,
    });
    const dialog = await openNewRequestDialog(page);

    // The ward's building is stated read-only...
    const locked = dialog.getByTestId('new-request-locked-building');
    await expect(locked).toContainText(WARD_BUILDING);
    await expect(locked).toContainText("Temporary access is limited to your ward's building.");

    // ...and the checklist that would let them pick another is absent
    // entirely — not merely disabled.
    await expect(dialog.getByTestId('new-request-buildings-trigger')).toHaveCount(0);
    await expect(dialog.getByTestId('new-request-building-cedar-building')).toHaveCount(0);
    await expect(dialog.getByTestId('new-request-building-maple-building')).toHaveCount(0);
    await expect(dialog.getByText(OTHER_BUILDING)).toHaveCount(0);
  });

  test('rejects a temp window longer than 90 days with a visible validation message', async ({
    page,
  }) => {
    await createSignedInUser(page, 'limited-bishop@example.com', {
      wards: [WARD],
      limited: true,
    });
    const dialog = await openNewRequestDialog(page);

    await dialog.getByTestId('new-request-email').fill('over.window@example.com');
    await dialog.getByTestId('new-request-name').fill('Over Window');
    await dialog.getByTestId('new-request-reason').fill('Extended project');
    await dialog.getByTestId('new-request-start-date').fill(TEMP_START);
    // 91 days — one day past the cap.
    await dialog.getByTestId('new-request-end-date').fill(TEMP_END_91_DAYS);
    await dialog.getByTestId('new-request-submit').click();

    await expect(dialog.getByRole('alert').filter({ hasText: TEMP_WINDOW_ERROR })).toBeVisible();
    // The dialog stays open and nothing was written.
    await expect(dialog.getByTestId('new-request-form')).toBeVisible();
    expect(await listDocs(`stakes/${STAKE_ID}/requests`)).toHaveLength(0);
  });

  test('accepts a 90-day temp window and lands a pending add_temp request in Firestore', async ({
    page,
  }) => {
    await createSignedInUser(page, 'limited-bishop@example.com', {
      wards: [WARD],
      limited: true,
    });
    const dialog = await openNewRequestDialog(page);

    await dialog.getByTestId('new-request-email').fill('at.cap@example.com');
    await dialog.getByTestId('new-request-name').fill('At Cap');
    await dialog.getByTestId('new-request-reason').fill('Scout camp coordinator');
    await dialog.getByTestId('new-request-start-date').fill(TEMP_START);
    // Exactly 90 days — the cap is inclusive.
    await dialog.getByTestId('new-request-end-date').fill(TEMP_END_90_DAYS);
    await dialog.getByTestId('new-request-submit').click();

    // Success closes the dialog and the row shows up under My Requests.
    await expect(dialog).toHaveCount(0);
    await page.getByRole('link', { name: /^My Requests$/ }).click();
    await expect(page.locator('[data-status="pending"]').first()).toBeVisible({ timeout: 10_000 });

    // What actually landed in Firestore — the UI echo isn't the contract.
    const requests = await listDocs(`stakes/${STAKE_ID}/requests`);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: 'add_temp',
      status: 'pending',
      scope: WARD,
      member_canonical: 'at.cap@example.com',
      start_date: TEMP_START,
      end_date: TEMP_END_90_DAYS,
      building_names: [WARD_BUILDING],
    });
  });

  test('hides Edit and Remove on auto and manual rows but offers both on a temp row for a limited bishopric', async ({
    page,
  }) => {
    await seedWardRosterWithEachSeatType();
    await createSignedInUser(page, 'limited-bishop@example.com', {
      wards: [WARD],
      limited: true,
    });

    await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
    // All three rows render before asserting on absence, so a missing
    // button can't be mistaken for a roster that hasn't hydrated.
    await expect(page.locator(`[data-seat-id="${AUTO_SEAT}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-seat-id="${MANUAL_SEAT}"]`)).toBeVisible();
    await expect(page.locator(`[data-seat-id="${TEMP_SEAT}"]`)).toBeVisible();

    // Durable grants are outside a limited user's authority.
    await expect(page.getByTestId(`edit-btn-${AUTO_SEAT}`)).toHaveCount(0);
    await expect(page.getByTestId(`remove-btn-${AUTO_SEAT}`)).toHaveCount(0);
    await expect(page.getByTestId(`edit-btn-${MANUAL_SEAT}`)).toHaveCount(0);
    await expect(page.getByTestId(`remove-btn-${MANUAL_SEAT}`)).toHaveCount(0);

    // The temp row is the one they own.
    await expect(page.getByTestId(`edit-btn-${TEMP_SEAT}`)).toBeVisible();
    await expect(page.getByTestId(`remove-btn-${TEMP_SEAT}`)).toBeVisible();
  });

  // ---- Control case ---------------------------------------------------
  //
  // Same ward, same seeded seats, no `limited` flag. Everything the
  // tests above assert is narrowed must still be wide open here.

  test('leaves both request types, the full building checklist, and manual-row Edit and Remove intact for a non-limited bishopric', async ({
    page,
  }) => {
    await seedWardRosterWithEachSeatType();
    await createSignedInUser(page, 'full-bishop@example.com', { wards: [WARD] });

    // Roster: the manual row keeps both affordances.
    await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
    await expect(page.locator(`[data-seat-id="${MANUAL_SEAT}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`edit-btn-${MANUAL_SEAT}`)).toBeVisible();
    await expect(page.getByTestId(`remove-btn-${MANUAL_SEAT}`)).toBeVisible();

    const dialog = await openNewRequestDialog(page);

    // Both request types on offer, defaulting to Manual.
    const typeSelect = dialog.getByTestId('new-request-type');
    await expect(typeSelect.locator('option')).toHaveText([
      'Manual (ongoing)',
      'Temporary (dated)',
    ]);
    await expect(typeSelect).toHaveValue('add_manual');

    // No 90-day cap notice, and no locked-building row.
    await expect(dialog.getByTestId('new-request-temp-cap-hint')).toHaveCount(0);
    await expect(dialog.getByTestId('new-request-locked-building')).toHaveCount(0);

    // The collapsible checklist is back, pre-selecting the ward's
    // building and still offering the other one.
    const trigger = dialog.getByTestId('new-request-buildings-trigger');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByTestId('new-request-buildings-summary')).toContainText(
      `Building: ${WARD_BUILDING}`,
    );
    await trigger.click();
    await expect(dialog.getByTestId('new-request-building-maple-building')).toBeChecked();
    await expect(dialog.getByTestId('new-request-building-cedar-building')).not.toBeChecked();
  });
});
