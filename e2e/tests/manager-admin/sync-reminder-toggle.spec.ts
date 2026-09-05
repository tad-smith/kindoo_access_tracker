// The Config tab's Sync Reminder card, against real rules and a real
// `stakeSchedules/{stakeId}` document.
//
// Component tests cover the three states against a mocked mutation
// (`apps/web/src/features/manager/configuration/ConfigurationPage.test.tsx`).
// What only this layer can prove is the write itself: the rules admit
// a manager's flip, the client transaction rewrites the array without
// disturbing the dispatcher's `next_trigger_time`, and no document is
// created when the dispatcher has not seeded one.

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

// A slot far enough out that the card prints it rather than "within the
// hour", and stable across whenever the suite happens to run.
const NEXT_SLOT = '2099-01-02T13:00:00.000Z';

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

async function signInAsManager(
  page: Page,
  email: string,
  stakeOverrides: Record<string, unknown> = {},
): Promise<void> {
  await writeDoc(`stakes/${STAKE_ID}`, {
    stake_name: 'Test Stake',
    bootstrap_admin_email: 'admin@example.com',
    setup_complete: true,
    stake_seat_cap: 200,
    timezone: 'America/Denver',
    ...stakeOverrides,
  });
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: { [STAKE_ID]: { manager: true, stake: false, wards: [] } },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email);
}

/** Seed the row the hourly dispatcher would have seeded. */
async function seedReminderRow(enabled: boolean): Promise<void> {
  await writeDoc(`stakeSchedules/${STAKE_ID}`, {
    tasks: [
      {
        job: 'syncReminder',
        enabled,
        schedule: { type: 'daily', hour: 6 },
        next_trigger_time: new Date(NEXT_SLOT),
      },
    ],
    lastActor: { email: 'dispatcher@example.com', canonical: 'dispatcher@example.com' },
  });
}

async function readReminderRow(): Promise<Record<string, unknown> | undefined> {
  const docs = await listDocs('stakeSchedules');
  const doc = docs.find((d) => d.__id__ === STAKE_ID);
  const tasks = doc?.['tasks'] as Array<Record<string, unknown>> | undefined;
  return tasks?.find((t) => t['job'] === 'syncReminder');
}

test.describe('Sync Reminder toggle (Configuration → Config)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('is inert, with an explanation, before the dispatcher has seeded the row', async ({
    page,
  }) => {
    await signInAsManager(page, 'mgr-sr-unseeded@example.com');
    await page.goto(`/manager/configuration?tab=config`);
    await expect(page.getByTestId('config-sync-reminder')).toBeVisible();
    await expect(page.getByTestId('config-sync-reminder-enabled')).toBeDisabled();
    await expect(page.getByTestId('config-sync-reminder-unseeded')).toContainText(
      /within the hour/i,
    );
    // Clicking a disabled control must not conjure the document.
    await page.getByTestId('config-sync-reminder-enabled').click({ force: true });
    await expect(page.getByTestId('config-sync-reminder-enabled')).toBeDisabled();
    expect(await listDocs('stakeSchedules')).toHaveLength(0);
  });

  test('a manager turning it on writes only enabled, keeping the dispatcher’s trigger time', async ({
    page,
  }) => {
    await seedReminderRow(false);
    await signInAsManager(page, 'mgr-sr-on@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    const toggle = page.getByTestId('config-sync-reminder-enabled');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await expect(async () => {
      const row = await readReminderRow();
      expect(row?.['enabled']).toBe(true);
    }).toPass();

    const row = await readReminderRow();
    // The dispatcher's fields survive the client's whole-array rewrite.
    // Compared as instants: Firestore re-serialises the timestamp
    // without milliseconds, so the strings differ where the moments do
    // not.
    expect(new Date(String(row?.['next_trigger_time'])).toISOString()).toBe(
      new Date(NEXT_SLOT).toISOString(),
    );
    expect(row?.['schedule']).toEqual({ type: 'daily', hour: 6 });

    // `lastActor` is re-stamped to the manager who flipped it — the
    // rules' integrity check requires exactly this.
    const docs = await listDocs('stakeSchedules');
    expect(docs[0]?.['lastActor']).toEqual({
      email: 'mgr-sr-on@example.com',
      canonical: 'mgr-sr-on@example.com',
    });
    // And nothing else was added to the document.
    expect(Object.keys(docs[0] ?? {}).sort()).toEqual(['__id__', 'lastActor', 'tasks']);
  });

  test('turning it back off persists, and the next-check line disappears with it', async ({
    page,
  }) => {
    await seedReminderRow(true);
    await signInAsManager(page, 'mgr-sr-off@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    const toggle = page.getByTestId('config-sync-reminder-enabled');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('config-sync-reminder-next')).toContainText('2099-01-02 06:00');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('config-sync-reminder-next')).toHaveCount(0);

    await expect(async () => {
      const row = await readReminderRow();
      expect(row?.['enabled']).toBe(false);
    }).toPass();
  });

  test('names the stake email kill-switch when it is off, and stays usable', async ({ page }) => {
    // `notifications_enabled: false` suppresses the reminder email in
    // `EmailService` but not the push, so the card warns rather than
    // disabling a control that still does something.
    await seedReminderRow(false);
    await signInAsManager(page, 'mgr-sr-blocked@example.com', { notifications_enabled: false });
    await page.goto(`/manager/configuration?tab=config`);

    const warning = page.getByTestId('config-sync-reminder-blocked');
    await expect(warning).toContainText(/Email Notifications Enabled is off for this stake/i);
    await expect(warning).toContainText(/still get the push/i);
    await expect(page.getByTestId('config-sync-reminder-enabled')).toBeEnabled();
  });

  test('is usable at a 375px mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedReminderRow(false);
    await signInAsManager(page, 'mgr-sr-mobile@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    const toggle = page.getByTestId('config-sync-reminder-enabled');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The card must not push the page into a horizontal scroll.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflows).toBe(false);
  });
});
