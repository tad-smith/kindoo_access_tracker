// E2E: remote apply on the manager Request Queue (D27), at a phone
// viewport — the device the feature exists for.
//
// What only an E2E can prove here: that the per-site gate is wired to
// real Firestore listeners reading a real `remoteApply/{canonical}` doc
// and its `desktops/{siteKey}` children through the deployed rules, and
// that the job the phone writes — including its `target_site_key` — is
// one the rules actually accept. The unit tests cover the same states
// against mocked hooks and can't see either of those.
//
// Presence is seeded through the emulator's REST bypass, standing in for
// the desktop extension's heartbeat: one parent opt-in doc plus one
// `desktops` child per Kindoo site with a live tab. The desktop half —
// claiming the job and reporting an outcome — has no Playwright harness
// (it needs a signed-in Kindoo tab), so the job's later transitions are
// seeded the same way, and their rules are covered by the rules tests
// and the extension's own unit tests.
//
// The stake is seeded with two Kindoo sites: the home site (Maple
// Building, ward CO) and a foreign site (Pine Building, ward PI), with
// one pending request on each. That's what makes per-card gating
// visible — one card's site is covered and the other's isn't, at the
// same moment, for the same manager.

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
/** Ward CO → Maple Building → home site. */
const HOME_REQUEST_ID = 'req-remote-home';
/** Ward PI → Pine Building → the `east` foreign site. */
const FOREIGN_REQUEST_ID = 'req-remote-east';
const FOREIGN_SITE_ID = 'east';
const HOME_SITE_KEY = 'home';
const HOME_SITE_NAME = 'Colorado Springs North';
const FOREIGN_SITE_NAME = 'East Stake (Pine)';

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
  await expect(page.getByTestId(`queue-card-${HOME_REQUEST_ID}`)).toBeVisible();
  await expect(page.getByTestId(`queue-card-${FOREIGN_REQUEST_ID}`)).toBeVisible();
}

async function seedBaseStake(): Promise<void> {
  await writeDoc('stakes/csnorth', {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    // The home site's only name lives here — home has no `kindooSites` doc.
    kindoo_config: { site_id: 4242, site_name: HOME_SITE_NAME },
  });
  await writeDoc(`stakes/csnorth/kindooSites/${FOREIGN_SITE_ID}`, {
    id: FOREIGN_SITE_ID,
    display_name: FOREIGN_SITE_NAME,
    kindoo_expected_site_name: FOREIGN_SITE_NAME,
    kindoo_eid: 9191,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  // Buildings carry the site; a ward's site is derived through its building.
  await writeDoc('stakes/csnorth/buildings/maple-building', {
    building_id: 'maple-building',
    building_name: 'Maple Building',
    address: '',
    kindoo_site_id: null,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/buildings/pine-building', {
    building_id: 'pine-building',
    building_name: 'Pine Building',
    address: '',
    kindoo_site_id: FOREIGN_SITE_ID,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/wards/CO', {
    ward_code: 'CO',
    ward_name: 'Maple',
    building_id: 'maple-building',
    building_name: 'Maple Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await writeDoc('stakes/csnorth/wards/PI', {
    ward_code: 'PI',
    ward_name: 'Pine',
    building_id: 'pine-building',
    building_name: 'Pine Building',
    seat_cap: 20,
    lastActor: { email: 'admin@example.com', canonical: 'admin@example.com' },
  });
  await seedRequest(HOME_REQUEST_ID, 'CO', 'Maple Building', 'newseat@example.com');
  await seedRequest(FOREIGN_REQUEST_ID, 'PI', 'Pine Building', 'pineseat@example.com');
}

async function seedRequest(
  requestId: string,
  scope: string,
  buildingName: string,
  memberEmail: string,
): Promise<void> {
  await writeDoc(`stakes/csnorth/requests/${requestId}`, {
    request_id: requestId,
    type: 'add_manual',
    scope,
    member_email: memberEmail,
    member_canonical: memberEmail,
    member_name: 'New Seat Person',
    reason: 'Primary teacher',
    comment: '',
    building_names: [buildingName],
    status: 'pending',
    requester_email: 'bishop@example.com',
    requester_canonical: 'bishop@example.com',
    requested_at: new Date('2026-04-20T08:00:00Z'),
    lastActor: { email: 'bishop@example.com', canonical: 'bishop@example.com' },
  });
}

/** The profile-wide opt-in. On its own it grants nothing — a tab has to be live too. */
async function seedOptIn(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeDoc(`remoteApply/${MANAGER_EMAIL}`, {
    remote_apply_enabled: true,
    ext_version: '2.5.0',
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    ...overrides,
  });
}

/**
 * Stand in for one Kindoo tab's heartbeat. `last_seen_at` drives
 * staleness; the doc id is the site key, so two tabs on two sites write
 * two docs rather than overwriting each other.
 */
async function seedDesktop(
  siteKey: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeDoc(`remoteApply/${MANAGER_EMAIL}/desktops/${siteKey}`, {
    stake_id: 'csnorth',
    kindoo_site_id: siteKey === HOME_SITE_KEY ? null : siteKey,
    last_seen_at: new Date(),
    kindoo_eid: siteKey === HOME_SITE_KEY ? 4242 : 9191,
    kindoo_site_name: siteKey === HOME_SITE_KEY ? HOME_SITE_NAME : FOREIGN_SITE_NAME,
    ext_version: '2.5.0',
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    ...overrides,
  });
}

/** A job the desktop already finished, written straight into the mailbox. */
async function seedJob(
  jobId: string,
  requestId: string,
  status: string,
  createdAt: Date,
  outcome?: Record<string, unknown>,
): Promise<void> {
  await writeDoc(`remoteApply/${MANAGER_EMAIL}/jobs/${jobId}`, {
    request_id: requestId,
    stake_id: 'csnorth',
    target_site_key: HOME_SITE_KEY,
    status,
    created_at: createdAt,
    created_by_device: 'device-1',
    finished_at: createdAt,
    lastActor: { email: MANAGER_EMAIL, canonical: MANAGER_EMAIL },
    ...(outcome ? { outcome } : {}),
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

  test('offers Apply only on the card whose Kindoo site has a live tab', async ({ page }) => {
    // One tab, on the home site. The foreign-site request is a request
    // this manager genuinely cannot apply from here right now, and the
    // page has to say which site to open rather than claim the desktop
    // is offline — it plainly isn't.
    await seedOptIn();
    await seedDesktop(HOME_SITE_KEY);
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      `You can apply requests for ${HOME_SITE_NAME} from here.`,
    );
    await expect(page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`)).toBeVisible();
    await expect(page.getByTestId(`remote-apply-button-${FOREIGN_REQUEST_ID}`)).toHaveCount(0);
    await expect(page.getByTestId(`remote-apply-needs-site-${FOREIGN_REQUEST_ID}`)).toContainText(
      `Open ${FOREIGN_SITE_NAME} in Kindoo on your computer to apply this one.`,
    );
  });

  test('covers both cards, and names both sites, when two Kindoo tabs are live', async ({
    page,
  }) => {
    await seedOptIn();
    await seedDesktop(HOME_SITE_KEY);
    await seedDesktop(FOREIGN_SITE_ID);
    await openQueueAsManager(page);

    const note = page.getByTestId('remote-apply-presence');
    await expect(note).toContainText(HOME_SITE_NAME);
    await expect(note).toContainText(FOREIGN_SITE_NAME);
    await expect(page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`)).toBeVisible();
    await expect(page.getByTestId(`remote-apply-button-${FOREIGN_REQUEST_ID}`)).toBeVisible();
    // Nothing to go open — both sites are covered.
    await expect(page.getByTestId(`remote-apply-needs-site-${HOME_REQUEST_ID}`)).toHaveCount(0);
    await expect(page.getByTestId(`remote-apply-needs-site-${FOREIGN_REQUEST_ID}`)).toHaveCount(0);
  });

  test('tapping Apply writes a queued job stamped with the site it must run on', async ({
    page,
  }) => {
    await seedOptIn();
    await seedDesktop(FOREIGN_SITE_ID);
    await openQueueAsManager(page);

    await page.getByTestId(`remote-apply-button-${FOREIGN_REQUEST_ID}`).click();

    // The row switches to the live job status…
    const status = page.getByTestId(`remote-apply-status-${FOREIGN_REQUEST_ID}`);
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-status', 'queued');
    // …and the button is gone, so a second tap can't queue a second job.
    await expect(page.getByTestId(`remote-apply-button-${FOREIGN_REQUEST_ID}`)).toHaveCount(0);

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
    expect(job['request_id']).toBe(FOREIGN_REQUEST_ID);
    expect(job['stake_id']).toBe('csnorth');
    // The site key is what stops the manager's home tab claiming this.
    expect(job['target_site_key']).toBe(FOREIGN_SITE_ID);
    expect(job['created_by_device']).toEqual(expect.any(String));
    expect(job['lastActor']).toEqual({ email: MANAGER_EMAIL, canonical: MANAGER_EMAIL });
  });

  test('stamps the home key on a request that provisions on the home site', async ({ page }) => {
    // Home has no `kindooSites` doc, so it is easy to write out as null
    // and let any tab claim it. The reserved key keeps it a real site.
    await seedOptIn();
    await seedDesktop(HOME_SITE_KEY);
    await openQueueAsManager(page);

    await page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`).click();

    await expect
      .poll(async () => (await listDocs(`remoteApply/${MANAGER_EMAIL}/jobs`)).length, {
        timeout: 10_000,
      })
      .toBe(1);
    const jobs = await listDocs(`remoteApply/${MANAGER_EMAIL}/jobs`);
    expect((jobs[0] as Record<string, unknown>)['target_site_key']).toBe(HOME_SITE_KEY);
  });

  test('reports a request that applied as applied, not as its failed duplicate', async ({
    page,
  }) => {
    // Two jobs for one request: the one that applied, and the orphan the
    // desktop claimed afterwards and refused because the request was no
    // longer pending. The orphan is the NEWER of the two and the only
    // one carrying a message, so anything that resolves by recency —
    // or by whichever doc a Map happened to keep last — reads this
    // request out as a failure. It is the one thing this surface must
    // never say: a manager told their apply failed goes and redoes a
    // provision that already consumed a licence.
    await seedOptIn();
    await seedDesktop(HOME_SITE_KEY);
    await seedJob('job-applied', HOME_REQUEST_ID, 'applied', new Date('2026-04-20T09:00:00Z'), {
      code: 'applied',
      message: 'Seat created in Kindoo.',
    });
    await seedJob('job-orphan', HOME_REQUEST_ID, 'failed', new Date('2026-04-20T09:00:30Z'), {
      code: 'request_not_pending',
      message: 'That request is no longer pending.',
    });
    await openQueueAsManager(page);

    const status = page.getByTestId(`remote-apply-status-${HOME_REQUEST_ID}`);
    await expect(status).toHaveAttribute('data-status', 'applied');
    await expect(status).toContainText('Applied ✓');
    await expect(status).not.toContainText(/didn't finish/i);
    await expect(status).not.toContainText(/no longer pending/i);
    // Settled: no retry button to double-provision with.
    await expect(page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`)).toHaveCount(0);
  });

  test('hides every button and says to open Kindoo when the heartbeats have gone stale', async ({
    page,
  }) => {
    await seedOptIn();
    await seedDesktop(HOME_SITE_KEY, { last_seen_at: new Date(Date.now() - 10 * 60_000) });
    await seedDesktop(FOREIGN_SITE_ID, { last_seen_at: new Date(Date.now() - 10 * 60_000) });
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      /Open Kindoo in Chrome on your computer/i,
    );
    await expect(page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`)).toHaveCount(0);
    await expect(page.getByTestId(`remote-apply-button-${FOREIGN_REQUEST_ID}`)).toHaveCount(0);
    // With nothing live, the header carries the whole message — no
    // per-card "open <site>" repeated down the queue.
    await expect(page.getByTestId(`remote-apply-needs-site-${FOREIGN_REQUEST_ID}`)).toHaveCount(0);
  });

  test('points at the extension toggle when the manager has not opted in', async ({ page }) => {
    // A live tab without consent grants nothing.
    await seedOptIn({ remote_apply_enabled: false });
    await seedDesktop(HOME_SITE_KEY);
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      /Allow requests from my phone/i,
    );
    await expect(page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`)).toHaveCount(0);
  });

  test('points at the extension toggle when no desktop has ever checked in', async ({ page }) => {
    // No mailbox at all — the state every manager is in until they
    // install the extension and turn the toggle on.
    await openQueueAsManager(page);

    await expect(page.getByTestId('remote-apply-presence')).toContainText(
      /Allow requests from my phone/i,
    );
    await expect(page.getByTestId(`remote-apply-button-${HOME_REQUEST_ID}`)).toHaveCount(0);
  });
});
