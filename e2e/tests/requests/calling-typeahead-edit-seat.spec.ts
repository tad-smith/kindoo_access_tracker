// The calling typeahead inside the Edit Seat modal — ward vs branch
// (T-100, architecture.md D32(i)).
//
// WHY THIS IS AN E2E AND NOT A COMPONENT TEST. `CallingCombobox` is a
// Radix Popover and `EditSeatDialog` is a Radix Dialog; under jsdom the
// Popover never mounts its content inside the Dialog, so no assertion
// can reach the suggestion list. A component test for exactly this was
// written during T-96, instrumented, confirmed dead, and removed rather
// than faked. Playwright drives a real browser, where the portal, the
// nested dismissable layers and the focus trap all behave — so this is
// the only place the rendered split can be observed.
//
// `callingsForScope` itself is unit-tested, and the same typeahead is
// covered in jsdom for `NewRequestForm` (not inside a Dialog). What is
// asserted here is only what those cannot reach: that opening Edit Seat
// on a BRANCH seat offers Branch President and not Bishop, and that
// picking a suggestion lands it in the field verbatim.
//
// The unit's kind comes from its NAME and nothing else (D31(a) — there
// is no `unit_type` field and none should be added). Both units below
// are seeded with neutral two-letter `ward_code`s precisely so the slug
// carries no hint: `GE` is a branch only because its `ward_name` ends
// in " Branch".
//
// Assertions name callings; never list length or index. The lists are
// computed by subtraction from a shared table that grows, so a count is
// a false failure waiting to happen.
//
// THE SELECTION TEST IS ALSO THE OCCLUSION TEST — don't weaken it to a
// keyboard selection. Playwright's `toBeVisible` is DOM visibility: a
// real box and no `display:none`. It says nothing about whether
// anything paints on top. Writing this spec is what surfaced the
// popover rendering BEHIND the modal panel (shadcn's `z-50` against
// `.kd-modal-positioner`'s 1301) — every "is this calling offered"
// assertion below passed green while a user could neither see nor click
// a single suggestion. Only `.click()`, which hit-tests, caught it. See
// `apps/web/src/components/ui/Popover.css`.

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

/** Ward unit — `unitType('Maple Ward')` is `'ward'`. */
const WARD_CODE = 'CO';
const WARD_SEAT = 'ward-member@example.com';

/** Branch unit — `unitType('Gleneagle Branch')` is `'branch'`. */
const BRANCH_CODE = 'GE';
const BRANCH_SEAT = 'branch-member@example.com';

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

/**
 * One stake holding a ward and a branch, each with a `manual` seat so
 * the Edit affordance opens the dialog's `edit_manual` sub-mode — the
 * only one that renders the `CallingCombobox` (`edit_temp`'s reason is
 * free text; `edit_auto` has no reason field at all).
 */
async function seedStakeWardAndBranch(): Promise<void> {
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_name: 'Test Stake',
    bootstrap_admin_email: ACTOR.email,
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/maple-building`, {
    building_id: 'maple-building',
    building_name: 'Maple Building',
    address: '123 Main',
    lastActor: ACTOR,
  });
  await writeDoc(`stakes/${STAKE_ID}/wards/${WARD_CODE}`, {
    ward_code: WARD_CODE,
    ward_name: 'Maple Ward',
    building_name: 'Maple Building',
    seat_cap: 20,
    lastActor: ACTOR,
  });
  // The branch. Its ONLY branch marker is the " Branch" suffix on
  // `ward_name`; the code is a neutral slug, as it is in production
  // (D31(e) leaves `ward_code` un-normalised on purpose).
  await writeDoc(`stakes/${STAKE_ID}/wards/${BRANCH_CODE}`, {
    ward_code: BRANCH_CODE,
    ward_name: 'Gleneagle Branch',
    building_name: 'Maple Building',
    seat_cap: 20,
    lastActor: ACTOR,
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/${WARD_SEAT}`, {
    member_canonical: WARD_SEAT,
    member_email: WARD_SEAT,
    member_name: 'Ward Member',
    scope: WARD_CODE,
    type: 'manual',
    callings: [],
    reason: 'Ward Clerk',
    building_names: ['Maple Building'],
    duplicate_grants: [],
    granted_by_request: 'seed-ward',
    lastActor: ACTOR,
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/${BRANCH_SEAT}`, {
    member_canonical: BRANCH_SEAT,
    member_email: BRANCH_SEAT,
    member_name: 'Branch Member',
    scope: BRANCH_CODE,
    type: 'manual',
    callings: [],
    reason: 'Branch Clerk',
    building_names: ['Maple Building'],
    duplicate_grants: [],
    granted_by_request: 'seed-branch',
    lastActor: ACTOR,
  });
}

/**
 * Sign in holding stake access plus bishopric of both units, which is
 * what `canEditSeat` needs to render the Edit affordance on each unit's
 * rows (and what `useRequireRole('stake')` needs to reach Ward Rosters).
 */
async function signInAsStakeBishopric(page: Page, email: string): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      [STAKE_ID]: { manager: false, stake: true, wards: [WARD_CODE, BRANCH_CODE] },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

/** Locator for one suggestion, keyed on the calling's own name. */
function option(page: Page, calling: string) {
  return page.getByTestId(`edit-seat-reason-option-${calling}`);
}

/** Open Ward Rosters at `wardCode` and click Edit on `seatCanonical`. */
async function openEditSeat(page: Page, wardCode: string, seatCanonical: string) {
  await page.goto(`/stake/wards?ward=${wardCode}`);
  await expect(page.getByRole('heading', { name: /^Ward Rosters$/ })).toBeVisible();
  await expect(page.locator(`[data-seat-id="${seatCanonical}"]`)).toBeVisible({ timeout: 10_000 });

  await page.getByTestId(`edit-btn-${seatCanonical}`).click();
  await expect(page.getByTestId('edit-seat-dialog-form')).toBeVisible();
}

/**
 * Open the dialog and empty the calling field so the popover lists every
 * suggestion for that scope rather than the seat's current calling
 * filtered down. Typing is what opens it — focus does not (B-27) — so
 * the `fill` below is load-bearing, not setup.
 */
async function openCallingList(page: Page, wardCode: string, seatCanonical: string) {
  await openEditSeat(page, wardCode, seatCanonical);

  const reason = page.getByTestId('edit-seat-reason');
  await reason.click();
  await reason.fill('');
  // The Popover mounting inside the Dialog is the thing jsdom could not
  // do; everything below depends on it, so wait for the list itself.
  await expect(page.getByTestId('edit-seat-reason-list')).toBeVisible();
  return reason;
}

test.describe('Edit Seat calling typeahead — ward vs branch', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedStakeWardAndBranch();
  });

  test('opens the dialog with no suggestion list covering the buildings checklist', async ({
    page,
  }) => {
    // B-27. The Dialog used to autofocus `reason` on mount; an `onFocus`
    // that opened the popover therefore dropped ~50 suggestions over the
    // checklist before the operator touched anything. Focus alone must
    // not open it — and as of B-28 nothing is focused on mount at all,
    // so this now asserts the weaker precondition too.
    await signInAsStakeBishopric(page, 'mount-typeahead@example.com');
    await openEditSeat(page, WARD_CODE, WARD_SEAT);

    const reason = page.getByTestId('edit-seat-reason');
    await expect(reason).not.toBeFocused();
    await expect(page.getByTestId('edit-seat-reason-list')).toHaveCount(0);

    // `toBeVisible` is DOM visibility and says nothing about occlusion
    // (see the header note) — the checkbox is clicked, which hit-tests,
    // so a popover painted over it fails here.
    const building = page.getByTestId('edit-seat-building-maple-building');
    await expect(building).toBeVisible();
    await building.click();
    await expect(building).toBeChecked({ checked: false });

    // Clicking into the field is still not an ask for suggestions.
    await reason.click();
    await expect(page.getByTestId('edit-seat-reason-list')).toHaveCount(0);

    // Typing is.
    await reason.fill('Ward Cl');
    await expect(option(page, 'Ward Clerk')).toBeVisible();
  });

  test('opens with no field focused and the pre-filled calling not selected', async ({ page }) => {
    // B-28, the follow-up to B-27. Radix's mount autofocus does not just
    // focus the first field, it `select()`s it — so this dialog, whose
    // every field is pre-filled from the seat, opened with the calling
    // highlighted and one keystroke from being replaced. jsdom can pin
    // the focus and the selection range; only a real browser shows that
    // the trap, Escape, and the Tab order all survive the opt-out.
    await signInAsStakeBishopric(page, 'mount-focus@example.com');
    await openEditSeat(page, WARD_CODE, WARD_SEAT);

    const reason = page.getByTestId('edit-seat-reason');
    await expect(reason).toHaveValue('Ward Clerk');
    await expect(reason).not.toBeFocused();

    // The `select: true` half of Radix's autofocus, pinned where it
    // actually lives: a text field's selection is the control's own, not
    // the document selection, so `window.getSelection()` reads empty
    // either way and would pin nothing. A collapsed range is the claim.
    const selectedLength = await reason.evaluate(
      (el) => (el as HTMLInputElement).selectionEnd! - (el as HTMLInputElement).selectionStart!,
    );
    expect(selectedLength).toBe(0);

    // Focus sits on the dialog itself — NOT on the trigger behind the
    // overlay, which is what a bare preventDefault would leave. That is
    // what keeps the trap armed and the dialog announced.
    const activeIsDialog = await page.evaluate(
      () => document.activeElement?.getAttribute('role') === 'dialog',
    );
    expect(activeIsDialog).toBe(true);

    // The trap holds: Tab from mount lands on the first field INSIDE the
    // dialog, never on the roster page behind it.
    await page.keyboard.press('Tab');
    await expect(reason).toBeFocused();
  });

  test('closes on Escape straight from open, with nothing clicked first', async ({ page }) => {
    // No click, no Tab — Escape as the very first interaction after the
    // dialog appears. Not a regression pin for B-28's opt-out: Radix
    // binds Escape on the document, so it fires wherever focus sits and
    // this passes with or without the fix. It is here because "nothing
    // is focused" is exactly the state a reader would doubt Escape from.
    await signInAsStakeBishopric(page, 'mount-escape@example.com');
    await openEditSeat(page, WARD_CODE, WARD_SEAT);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-seat-dialog-form')).toHaveCount(0);
  });

  test('offers branch callings and hides the ward-only ones when editing a branch seat', async ({
    page,
  }) => {
    await signInAsStakeBishopric(page, 'branch-typeahead@example.com');
    await openCallingList(page, BRANCH_CODE, BRANCH_SEAT);

    // The branch entries a branch reuses.
    await expect(option(page, 'Branch President')).toBeVisible();
    await expect(option(page, 'Branch Presidency First Counselor')).toBeVisible();
    await expect(option(page, 'Branch Clerk')).toBeVisible();

    // The ward entries a branch swaps out.
    await expect(option(page, 'Bishop')).toHaveCount(0);
    await expect(option(page, 'Bishopric First Counselor')).toHaveCount(0);
    await expect(option(page, 'Ward Clerk')).toHaveCount(0);

    // A branch has no executive secretary at all — both entries are
    // dropped with no replacement (D32(i)).
    await expect(option(page, 'Ward Executive Secretary')).toHaveCount(0);
    await expect(option(page, 'Ward Assistant Executive Secretary')).toHaveCount(0);
  });

  test('offers ward callings and no branch calling when editing a ward seat', async ({ page }) => {
    await signInAsStakeBishopric(page, 'ward-typeahead@example.com');
    await openCallingList(page, WARD_CODE, WARD_SEAT);

    await expect(option(page, 'Bishop')).toBeVisible();
    await expect(option(page, 'Bishopric First Counselor')).toBeVisible();
    await expect(option(page, 'Ward Clerk')).toBeVisible();
    await expect(option(page, 'Ward Executive Secretary')).toBeVisible();

    // Not just the three named above: nothing whose calling name starts
    // "Branch " is offered at a ward. Prefix-matched on the name so a
    // future branch entry in the shared table is covered too.
    await expect(page.locator('[data-testid^="edit-seat-reason-option-Branch "]')).toHaveCount(0);
  });

  test('offers the callings shared by both unit kinds at a ward and at a branch', async ({
    page,
  }) => {
    await signInAsStakeBishopric(page, 'shared-typeahead@example.com');

    await openCallingList(page, WARD_CODE, WARD_SEAT);
    await expect(option(page, 'Relief Society President')).toBeVisible();
    await expect(option(page, 'Sunday School President')).toBeVisible();
    await expect(option(page, 'Elders Quorum President')).toBeVisible();

    await openCallingList(page, BRANCH_CODE, BRANCH_SEAT);
    await expect(option(page, 'Relief Society President')).toBeVisible();
    await expect(option(page, 'Sunday School President')).toBeVisible();
    await expect(option(page, 'Elders Quorum President')).toBeVisible();
  });

  test('puts the selected calling in the field verbatim', async ({ page }) => {
    await signInAsStakeBishopric(page, 'select-typeahead@example.com');

    // The combobox accepts free text, so filtering to a suggestion is
    // not the same as selecting it — assert the field's own value.
    const branchReason = await openCallingList(page, BRANCH_CODE, BRANCH_SEAT);
    await branchReason.fill('Branch Pres');
    await option(page, 'Branch President').click();
    await expect(branchReason).toHaveValue('Branch President');

    const wardReason = await openCallingList(page, WARD_CODE, WARD_SEAT);
    await wardReason.fill('Ward Exec');
    await option(page, 'Ward Executive Secretary').click();
    await expect(wardReason).toHaveValue('Ward Executive Secretary');
  });
});
