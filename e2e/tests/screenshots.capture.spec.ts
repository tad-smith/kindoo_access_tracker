// One-purpose capture utility for the end-user documentation guides.
//
// NOT part of the regression suite — run it explicitly to (re)generate
// the six web-app screenshots wired into the HTML guides under
// `docs/user-guide/`:
//
//   npx playwright test screenshots.capture.spec.ts
//
// (Always run it under a fresh emulator instance — see the command in
// the task brief / the worktree report.)
//
// All data is clearly-fake demo data (Cedar Springs Stake, Maple /
// Pine wards, James Whitfield / Sarah Bennett / @example.org emails).
// No real identifiers. The shots are deterministic seed → render →
// `page.screenshot`, captured at a desktop viewport with
// deviceScaleFactor 2 for crisp images.
//
// The six figures captured here (placeholders the guides leave for the
// web app):
//   creating-requests.html  Fig 2.1  sign-in (signed-out)        → sign-in.png
//   creating-requests.html  Fig 4.1  bishopric ward roster       → ward-roster.png
//   creating-requests.html  Fig 5.1  New Request form (dialog)   → new-request-form.png
//   creating-requests.html  Fig 9.1  My Requests (mixed status)  → my-requests.png
//   kindoo-managers.html    Fig 2.1  bootstrap setup wizard      → bootstrap-wizard.png
//   kindoo-managers.html    Fig 11.1 audit log (expanded diff)   → audit-log-expanded.png
//
// The three extension figures (kindoo-managers 3.1 / 5.1 / 6.1) need a
// live Kindoo session + the extension and are intentionally NOT
// captured here; the guides keep their placeholders.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
  writeDoc,
} from '../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';
const STAKE_ID = 'cedar-springs';
const TZ = 'America/Denver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG_DIR = path.resolve(__dirname, '../../docs/user-guide/img');

// Desktop capture viewport. deviceScaleFactor 2 → retina-crisp PNGs.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

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
}

async function signInWithClaims(
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
      },
    },
  });
  await page.goto(startUrl);
  await signInViaTestHatch(page, email);
}

const actor = (email: string) => ({ email, canonical: email });

async function seedSetupCompleteStake(): Promise<void> {
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_name: 'Cedar Springs Stake',
    bootstrap_admin_email: 'admin@example.org',
    setup_complete: true,
    stake_seat_cap: 200,
    timezone: TZ,
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/maple-building`, {
    building_id: 'maple-building',
    building_name: 'Maple Building',
    address: '482 Maple Avenue',
    lastActor: actor('admin@example.org'),
  });
  await writeDoc(`stakes/${STAKE_ID}/buildings/cedar-building`, {
    building_id: 'cedar-building',
    building_name: 'Cedar Building',
    address: '120 Cedar Lane',
    lastActor: actor('admin@example.org'),
  });
  await writeDoc(`stakes/${STAKE_ID}/wards/maple`, {
    ward_code: 'maple',
    ward_name: 'Maple Ward',
    building_name: 'Maple Building',
    seat_cap: 24,
    lastActor: actor('admin@example.org'),
  });
  await writeDoc(`stakes/${STAKE_ID}/wards/pine`, {
    ward_code: 'pine',
    ward_name: 'Pine Ward',
    building_name: 'Cedar Building',
    seat_cap: 24,
    lastActor: actor('admin@example.org'),
  });
}

// A realistic mix of seat rows for the Maple Ward roster: auto
// (calling-based), manual (ongoing), and temp (date-bounded).
async function seedMapleWardRoster(): Promise<void> {
  const now = new Date('2026-06-01T17:00:00Z');
  const base = {
    scope: 'maple',
    callings: [] as string[],
    duplicate_grants: [],
    duplicate_scopes: [],
    created_at: now,
    last_modified_at: now,
    last_modified_by: actor('manager@example.org'),
    lastActor: actor('manager@example.org'),
  };

  await writeDoc(`stakes/${STAKE_ID}/seats/james.whitfield@example.org`, {
    ...base,
    member_canonical: 'james.whitfield@example.org',
    member_email: 'james.whitfield@example.org',
    member_name: 'James Whitfield',
    type: 'auto',
    callings: ['Bishop'],
    building_names: ['Maple Building'],
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/daniel.foster@example.org`, {
    ...base,
    member_canonical: 'daniel.foster@example.org',
    member_email: 'daniel.foster@example.org',
    member_name: 'Daniel Foster',
    type: 'auto',
    callings: ['Bishopric First Counselor'],
    building_names: ['Maple Building'],
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/sarah.bennett@example.org`, {
    ...base,
    member_canonical: 'sarah.bennett@example.org',
    member_email: 'sarah.bennett@example.org',
    member_name: 'Sarah Bennett',
    type: 'manual',
    reason: 'Building scheduler',
    building_names: ['Maple Building'],
    granted_by_request: 'seed-req-bennett',
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/michael.reyes@example.org`, {
    ...base,
    member_canonical: 'michael.reyes@example.org',
    member_email: 'michael.reyes@example.org',
    member_name: 'Michael Reyes',
    type: 'manual',
    reason: 'Facilities maintenance volunteer',
    building_names: ['Maple Building'],
    granted_by_request: 'seed-req-reyes',
  });
  await writeDoc(`stakes/${STAKE_ID}/seats/emily.carter@example.org`, {
    ...base,
    member_canonical: 'emily.carter@example.org',
    member_email: 'emily.carter@example.org',
    member_name: 'Emily Carter',
    type: 'temp',
    reason: 'Youth conference setup crew',
    start_date: '2026-06-08',
    end_date: '2026-06-22',
    building_names: ['Maple Building'],
    granted_by_request: 'seed-req-carter',
  });
}

// Mixed-status requests submitted by the signed-in bishop for the
// My Requests page: one pending (cancellable), one complete (with a
// note), one rejected (with a reason).
async function seedBishopRequests(requesterEmail: string): Promise<void> {
  const reqBase = {
    scope: 'maple',
    requester_email: requesterEmail,
    requester_canonical: requesterEmail,
    lastActor: actor(requesterEmail),
  };

  await writeDoc(`stakes/${STAKE_ID}/requests/req-pending`, {
    ...reqBase,
    request_id: 'req-pending',
    type: 'add_manual',
    member_email: 'olivia.morgan@example.org',
    member_canonical: 'olivia.morgan@example.org',
    member_name: 'Olivia Morgan',
    reason: 'New ward organist',
    comment: '',
    building_names: ['Maple Building'],
    status: 'pending',
    requested_at: new Date('2026-06-05T15:30:00Z'),
  });
  await writeDoc(`stakes/${STAKE_ID}/requests/req-complete`, {
    ...reqBase,
    request_id: 'req-complete',
    type: 'add_temp',
    member_email: 'nathan.brooks@example.org',
    member_canonical: 'nathan.brooks@example.org',
    member_name: 'Nathan Brooks',
    reason: 'Scout camp coordinator',
    comment: '',
    building_names: ['Maple Building'],
    start_date: '2026-05-20',
    end_date: '2026-06-15',
    status: 'complete',
    completion_note: 'Access granted in Kindoo.',
    requested_at: new Date('2026-05-18T14:00:00Z'),
  });
  await writeDoc(`stakes/${STAKE_ID}/requests/req-rejected`, {
    ...reqBase,
    request_id: 'req-rejected',
    type: 'add_manual',
    member_email: 'grace.holland@example.org',
    member_canonical: 'grace.holland@example.org',
    member_name: 'Grace Holland',
    reason: 'Activities helper',
    comment: '',
    building_names: ['Maple Building'],
    status: 'rejected',
    rejection_reason: 'This member already has a seat — no change needed.',
    requested_at: new Date('2026-05-12T19:45:00Z'),
  });
}

// Audit rows for the manager Audit Log. The featured row is an
// `update_seat` whose before/after differ on a couple of fields so the
// `<details>` expansion renders a Field / Before / After diff table.
async function seedAuditLog(): Promise<void> {
  const ttl = new Date('2027-06-01T00:00:00Z');

  // Featured row — a manual seat whose buildings + reason changed.
  // Expanding this row shows the before/after diff in the guide.
  await writeDoc(`stakes/${STAKE_ID}/auditLog/2026-06-03T18-30-00_aaaa`, {
    audit_id: '2026-06-03T18-30-00_aaaa',
    timestamp: new Date('2026-06-03T18:30:00Z'),
    actor_email: 'manager@example.org',
    actor_canonical: 'manager@example.org',
    action: 'update_seat',
    entity_type: 'seat',
    entity_id: 'sarah.bennett@example.org',
    member_canonical: 'sarah.bennett@example.org',
    before: {
      member_email: 'sarah.bennett@example.org',
      member_name: 'Sarah Bennett',
      scope: 'maple',
      type: 'manual',
      reason: 'Building scheduler',
      building_names: ['Maple Building'],
    },
    after: {
      member_email: 'sarah.bennett@example.org',
      member_name: 'Sarah Bennett',
      scope: 'maple',
      type: 'manual',
      reason: 'Building scheduler and activities coordinator',
      building_names: ['Maple Building', 'Cedar Building'],
    },
    ttl,
  });

  await writeDoc(`stakes/${STAKE_ID}/auditLog/2026-06-03T16-05-00_bbbb`, {
    audit_id: '2026-06-03T16-05-00_bbbb',
    timestamp: new Date('2026-06-03T16:05:00Z'),
    actor_email: 'manager@example.org',
    actor_canonical: 'manager@example.org',
    action: 'complete_request',
    entity_type: 'request',
    entity_id: 'req-complete',
    member_canonical: 'nathan.brooks@example.org',
    before: { status: 'pending' },
    after: { status: 'complete', completion_note: 'Access granted in Kindoo.' },
    ttl,
  });

  await writeDoc(`stakes/${STAKE_ID}/auditLog/2026-06-02T21-15-00_cccc`, {
    audit_id: '2026-06-02T21-15-00_cccc',
    timestamp: new Date('2026-06-02T21:15:00Z'),
    actor_email: 'bishop@example.org',
    actor_canonical: 'bishop@example.org',
    action: 'submit_request',
    entity_type: 'request',
    entity_id: 'req-pending',
    member_canonical: 'olivia.morgan@example.org',
    before: null,
    after: {
      member_email: 'olivia.morgan@example.org',
      member_name: 'Olivia Morgan',
      scope: 'maple',
      type: 'add_manual',
      reason: 'New ward organist',
      status: 'pending',
    },
    ttl,
  });

  await writeDoc(`stakes/${STAKE_ID}/auditLog/2026-06-02T09-40-00_dddd`, {
    audit_id: '2026-06-02T09-40-00_dddd',
    timestamp: new Date('2026-06-02T09:40:00Z'),
    actor_email: 'SyncActor:maple',
    actor_canonical: 'SyncActor:maple',
    action: 'create_seat',
    entity_type: 'seat',
    entity_id: 'emily.carter@example.org',
    member_canonical: 'emily.carter@example.org',
    before: null,
    after: {
      member_email: 'emily.carter@example.org',
      member_name: 'Emily Carter',
      scope: 'maple',
      type: 'temp',
      reason: 'Youth conference setup crew',
      building_names: ['Maple Building'],
    },
    ttl,
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(IMG_DIR, name) });
}

test.describe('User-guide screenshot capture', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('Fig 2.1 (creating-requests) — sign-in page, signed out', async ({ page }) => {
    await page.goto('/');
    // The hero CTA proves the signed-out sign-in surface has rendered.
    await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Send me a sign-in link/ })).toBeVisible();
    await shoot(page, 'sign-in.png');
  });

  test('Fig 4.1 (creating-requests) — bishopric ward roster', async ({ page }) => {
    await seedSetupCompleteStake();
    await seedMapleWardRoster();
    await signInWithClaims(page, 'bishop@example.org', { wards: ['maple'] });

    await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
    await expect(page.getByTestId('bishopric-roster-new-request')).toBeVisible();
    // Wait for every seeded row to land so the roster isn't half-empty.
    await expect(page.getByText('James Whitfield')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Emily Carter')).toBeVisible();
    await shoot(page, 'ward-roster.png');
  });

  test('Fig 5.1 (creating-requests) — New Request form dialog', async ({ page }) => {
    await seedSetupCompleteStake();
    await seedMapleWardRoster();
    await signInWithClaims(page, 'bishop@example.org', { wards: ['maple'] });

    await expect(page.getByRole('heading', { name: /^Roster$/ })).toBeVisible();
    await page.getByTestId('bishopric-roster-new-request').click();
    // Select the modal by its accessible name — a Radix popover inside
    // the form also carries role="dialog", so the bare role is ambiguous.
    const dialog = page.getByRole('dialog', { name: 'New Request' });
    await expect(dialog.getByTestId('new-request-form')).toBeVisible();
    // Fill a realistic set of fields so the dialog isn't an empty shell.
    await dialog.getByTestId('new-request-email').fill('olivia.morgan@example.org');
    await dialog.getByTestId('new-request-name').fill('Olivia Morgan');
    await dialog.getByTestId('new-request-reason').fill('New ward organist');
    // Capture just the dialog element, not the whole page.
    await dialog.screenshot({ path: path.join(IMG_DIR, 'new-request-form.png') });
  });

  test('Fig 9.1 (creating-requests) — My Requests, mixed statuses', async ({ page }) => {
    await seedSetupCompleteStake();
    await seedBishopRequests('bishop@example.org');
    await signInWithClaims(page, 'bishop@example.org', { wards: ['maple'] }, '/?p=myreq');

    await expect(page.getByRole('heading', { name: /^My Requests$/ })).toBeVisible();
    await expect(page.getByTestId('myrequests-cards')).toBeVisible({ timeout: 10_000 });
    // All three statuses present, and the pending row offers Cancel.
    await expect(page.locator('[data-status="pending"]')).toBeVisible();
    await expect(page.locator('[data-status="complete"]')).toBeVisible();
    await expect(page.locator('[data-status="rejected"]')).toBeVisible();
    await expect(page.getByTestId('myrequest-cancel-req-pending')).toBeVisible();
    await shoot(page, 'my-requests.png');
  });

  test('Fig 2.1 (kindoo-managers) — bootstrap setup wizard', async ({ page }) => {
    // setup_complete=false + bootstrap_admin_email = signed-in user →
    // the gate renders the wizard. Advance to the Buildings step (2).
    await writeDoc(`stakes/${STAKE_ID}`, {
      stake_name: 'Cedar Springs Stake',
      bootstrap_admin_email: 'admin@example.org',
      setup_complete: false,
      stake_seat_cap: 0,
      timezone: TZ,
    });
    const { uid } = await createAuthUser({ email: 'admin@example.org' });
    await setCustomClaims(uid, { canonical: 'admin@example.org', stakes: {} });
    await page.goto(`/?stake=${STAKE_ID}`);
    await signInViaTestHatch(page, 'admin@example.org');

    await expect(page.getByTestId('bootstrap-wizard')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Set up Stake Building Access/i }),
    ).toBeVisible();
    // Buildings step shows the add-building form — a concrete step that
    // reads better in the guide than the bare stake-details step.
    await page.getByTestId('wizard-step-tab-2').click();
    const step2 = page.getByTestId('wizard-step-2');
    await step2.getByLabel(/^Building name$/).fill('Maple Building');
    await step2.getByLabel(/^Address$/).fill('482 Maple Avenue');
    await step2.getByRole('button', { name: /^Add building$/ }).click();
    await expect(
      page.getByTestId('bootstrap-buildings-list').getByText('Maple Building'),
    ).toBeVisible();
    await shoot(page, 'bootstrap-wizard.png');
  });

  test('Fig 11.1 (kindoo-managers) — audit log with an expanded diff', async ({ page }) => {
    await seedSetupCompleteStake();
    await seedAuditLog();
    await signInWithClaims(page, 'manager@example.org', { manager: true }, '/?p=mgr/audit');

    await expect(page.getByRole('heading', { name: /^Audit Log$/ })).toBeVisible();
    await expect(page.getByTestId('audit-log-cards')).toBeVisible({ timeout: 10_000 });
    // Expand the featured update_seat row's <details> so the diff table
    // is visible in the capture.
    const featured = page.getByTestId('audit-row-2026-06-03T18-30-00_aaaa');
    await expect(featured).toBeVisible();
    await featured.locator('summary').click();
    await expect(featured.getByTestId('audit-diff-table')).toBeVisible();
    // The changed fields render in the diff.
    await expect(featured.getByTestId('audit-diff-row-building_names')).toBeVisible();
    await shoot(page, 'audit-log-expanded.png');
  });
});
