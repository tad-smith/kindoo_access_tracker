// E2E: the manager Request Queue is a read-only visibility surface.
//
// The actionable complete / reject workflow moved entirely to the
// Chrome extension. The app queue now only displays pending requests —
// sectioned by urgency, with no per-card action buttons — and shows a
// muted note pointing the manager to the extension.
//
// We seed pending request docs straight into Firestore (the emulator
// REST write bypasses rules) and load the queue as a manager, then
// assert: cards render in their sections, no complete / reject button
// exists anywhere, and the read-only note links to the Web Store.

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

async function createSignedInManager(page: Page, email: string, startUrl = '/'): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: { csnorth: { manager: true, stake: false, wards: [] } },
  });
  await page.goto(startUrl);
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

async function seedBaseStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc('stakes/csnorth/buildings/maple-building', {
    building_id: 'maple-building',
    building_name: 'Maple Building',
    address: '123 Main',
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Maple',
    building_name: 'Maple Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
}

async function seedPendingRequest(
  requestId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeDoc(`stakes/csnorth/requests/${requestId}`, {
    request_id: requestId,
    type: 'add_manual',
    scope: 'CO',
    member_email: 'newseat@example.com',
    member_canonical: 'newseat@example.com',
    member_name: 'New Seat Person',
    reason: 'Primary teacher',
    comment: '',
    building_names: ['Maple Building'],
    status: 'pending',
    requester_email: 'bishop@example.com',
    requester_canonical: 'bishop@example.com',
    requested_at: new Date('2026-04-20T08:00:00Z'),
    lastActor: { email: 'bishop@example.com', canonical: 'bishop@example.com' },
    ...overrides,
  });
}

test.describe('manager Request Queue — read-only', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('lists pending requests in sections with no action buttons and shows the extension note', async ({
    page,
  }) => {
    await seedPendingRequest('req-normal', {
      member_email: 'normal@example.com',
      member_canonical: 'normal@example.com',
      member_name: 'Normal Person',
    });
    await seedPendingRequest('req-urgent', {
      member_email: 'urgent@example.com',
      member_canonical: 'urgent@example.com',
      member_name: 'Urgent Person',
      urgent: true,
      comment: 'Needs access before Sunday.',
    });

    await createSignedInManager(page, 'manager@example.com');
    await page.getByRole('link', { name: /^Request Queue$/ }).click();
    await expect(page.getByRole('heading', { name: /^Request Queue$/ })).toBeVisible();

    // Both seeded requests render as cards.
    await expect(page.getByTestId('queue-card-req-normal')).toBeVisible();
    await expect(page.getByTestId('queue-card-req-urgent')).toBeVisible();

    // Urgent lands in the Urgent section; the non-urgent one in Outstanding.
    await expect(page.getByTestId('queue-section-urgent')).toBeVisible();
    await expect(
      page.getByTestId('queue-section-urgent').getByTestId('queue-card-req-urgent'),
    ).toBeVisible();
    await expect(
      page.getByTestId('queue-section-outstanding').getByTestId('queue-card-req-normal'),
    ).toBeVisible();

    // Read-only: there are NO complete / reject affordances anywhere on
    // the page.
    await expect(page.locator('[data-testid^="queue-complete-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="queue-reject-"]')).toHaveCount(0);

    // The muted note points the manager to the Chrome extension and
    // links to the Web Store listing.
    const note = page.getByTestId('queue-readonly-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/completed or rejected from the Chrome extension/i);
    const link = page.getByTestId('queue-readonly-note-link');
    await expect(link).toHaveAttribute('href', /chromewebstore\.google\.com/);
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('shows the empty state and the note when there are no pending requests', async ({
    page,
  }) => {
    await createSignedInManager(page, 'manager2@example.com');
    await page.getByRole('link', { name: /^Request Queue$/ }).click();
    await expect(page.getByRole('heading', { name: /^Request Queue$/ })).toBeVisible();
    await expect(page.getByText(/no pending requests/i)).toBeVisible();
    // The note renders regardless of whether the queue has any requests.
    await expect(page.getByTestId('queue-readonly-note')).toBeVisible();
  });

  test('is usable at a 375px mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedPendingRequest('req-mobile');
    await createSignedInManager(page, 'manager3@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();
    // On mobile the nav lives behind the hamburger drawer.
    await page.getByRole('button', { name: /open navigation/i }).click();
    const drawer = page.locator('.kd-nav-overlay-drawer');
    await drawer.getByRole('link', { name: /^Request Queue$/ }).click();
    await expect(page.getByRole('heading', { name: /^Request Queue$/ })).toBeVisible();
    await expect(page.getByTestId('queue-card-req-mobile')).toBeVisible();
    await expect(page.getByTestId('queue-readonly-note')).toBeVisible();
  });
});
