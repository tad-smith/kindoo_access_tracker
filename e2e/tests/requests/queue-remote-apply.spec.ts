// E2E: remote apply on the manager Request Queue (D27), at a phone
// viewport — the device the feature exists for.
//
// What only an E2E can prove here: that the presence gate is wired to a
// real Firestore listener reading a real `remoteApply/{canonical}` doc
// through the deployed rules, and that the job the phone writes is one
// the rules actually accept. The unit tests cover the same states
// against mocked hooks and can't see either of those.
//
// Presence is seeded through the emulator's REST bypass, standing in for
// the desktop extension's heartbeat. The desktop half — claiming the job
// and reporting an outcome — has no Playwright harness (it needs a
// signed-in Kindoo tab), so the job's later transitions are covered by
// the rules tests and the extension's own unit tests.

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
const MANAGER_EMAIL = 'remote-mgr@example.com';
const REQUEST_ID = 'req-remote';

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

async function openQueueAsManager(page: Page): Promise<void> {
  const { uid } = await createAuthUser({ email: MANAGER_EMAIL });
  await setCustomClaims(uid, {
    canonical: MANAGER_EMAIL,
    stakes: { csnorth: { manager: true, stake: false, wards: [] } },
  });
  await page.goto('/');
  await signInViaTestHatch(page, MANAGER_EMAIL, TEST_PASSWORD);
  await page.goto('/manager/queue');
  await expect(page.getByRole('heading', { name: /^Request Queue$/ })).toBeVisible();
  await expect(page.getByTestId(`queue-card-${REQUEST_ID}`)).toBeVisible();
}

async function seedBaseStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
  });
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Maple',
    building_name: 'Maple Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc(`stakes/csnorth/requests/${REQUEST_ID}`, {
    request_id: REQUEST_ID,
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
  });
}

/** Stand in for the extension's heartbeat. `lastSeen` drives staleness. */
async function seedPresence(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeDoc(`remoteApply/${MANAGER_EMAIL}`, {
    remote_apply_enabled: true,
    last_seen_at: new Date(),
    stake_id: 'csnorth',
    kindoo_eid: 4242,
    kindoo_site_name: 'Colorado Springs North',
    ext_version: '2.4.0',
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    ...overrides,
  });
}

test.describe('manager Request Queue — remote apply', () => {
  test.beforeEach(async ({ page }) => {
    // Phone viewport: this whole feature exists because the manager is
    // holding a phone in a building, not sitting at their desk.
    await page.setViewportSize({ width: 390, height: 844 });
    await clearAuth();
    await clearFirestore();
    await seedBaseStake();
  });

  test('offers Apply via extension, naming the Kindoo site the desktop is in', async ({ page }) => {
    await seedPresence();
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      'Desktop online — Kindoo site: Colorado Springs North',
    );
    const button = page.getByTestId(`remote-apply-button-${REQUEST_ID}`);
    await expect(button).toBeVisible();
    await expect(button).toContainText('Apply via extension');
  });

  test('tapping Apply writes a queued job the desktop can claim', async ({ page }) => {
    await seedPresence();
    await openQueueAsManager(page);

    await page.getByTestId(`remote-apply-button-${REQUEST_ID}`).click();

    // The row switches to the live job status…
    const status = page.getByTestId(`remote-apply-status-${REQUEST_ID}`);
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-status', 'queued');
    // …and the button is gone, so a second tap can't queue a second job.
    await expect(page.getByTestId(`remote-apply-button-${REQUEST_ID}`)).toHaveCount(0);

    // The write the production rules accepted, read back raw: exactly the
    // fields the phone is allowed to set, at `queued`. Polled because the
    // row above renders from the local cache the instant the write is
    // enqueued — the server ack lands a beat later, and a rules rejection
    // would show up here as the doc never arriving.
    await expect
      .poll(async () => (await listDocs(`remoteApply/${MANAGER_EMAIL}/jobs`)).length, {
        timeout: 10_000,
      })
      .toBe(1);
    const jobs = await listDocs(`remoteApply/${MANAGER_EMAIL}/jobs`);
    const job = jobs[0] as Record<string, unknown>;
    expect(job['status']).toBe('queued');
    expect(job['request_id']).toBe(REQUEST_ID);
    expect(job['stake_id']).toBe('csnorth');
    expect(job['created_by_device']).toEqual(expect.any(String));
    expect(job['lastActor']).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
  });

  test('hides the button and says to open Kindoo when the heartbeat has gone stale', async ({
    page,
  }) => {
    await seedPresence({ last_seen_at: new Date(Date.now() - 10 * 60_000) });
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      /isn't online — open Kindoo in Chrome on your computer/i,
    );
    await expect(page.getByTestId(`remote-apply-button-${REQUEST_ID}`)).toHaveCount(0);
  });

  test('points at the extension toggle when the manager has not opted in', async ({ page }) => {
    await seedPresence({ remote_apply_enabled: false });
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      /Allow requests from my phone/i,
    );
    await expect(page.getByTestId(`remote-apply-button-${REQUEST_ID}`)).toHaveCount(0);
  });

  test('points at the extension toggle when no desktop has ever checked in', async ({ page }) => {
    // No presence doc at all — the state every manager is in until they
    // install the extension and turn the toggle on.
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      /Allow requests from my phone/i,
    );
    await expect(page.getByTestId(`remote-apply-button-${REQUEST_ID}`)).toHaveCount(0);
  });
});
