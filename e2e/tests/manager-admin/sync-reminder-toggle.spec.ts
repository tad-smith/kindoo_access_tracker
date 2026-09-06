// The Config tab's stake-level sliders, against real rules and real
// documents.
//
// Component tests cover the states against mocked mutations
// (`apps/web/src/features/manager/configuration/ConfigurationPage.test.tsx`).
// What only this layer can prove is the writes themselves: that the
// rules admit a manager flipping each one, that a slider writes its own
// field and nothing else, that the sync-reminder transaction rewrites
// the tasks array without disturbing the dispatcher's
// `next_trigger_time`, and that no schedule document is created when
// the dispatcher has not seeded one.

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

async function readStake(): Promise<Record<string, unknown> | undefined> {
  const docs = await listDocs('stakes');
  return docs.find((d) => d.__id__ === STAKE_ID);
}

test.describe('Config tab sliders (Configuration → Config)', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('each slider writes its own field the moment it moves, with no Save', async ({ page }) => {
    await seedReminderRow(false);
    await signInAsManager(page, 'mgr-sliders@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    // Email notifications: on by default (absent field), flipped off.
    const email = page.getByTestId('config-notifications-enabled');
    await expect(email).toHaveAttribute('aria-checked', 'true');
    await email.click();
    await expect(async () => {
      expect((await readStake())?.['notifications_enabled']).toBe(false);
    }).toPass();
    // The write touched that field alone — the form's fields are the
    // Save button's business, not a slider's.
    expect((await readStake())?.['stake_name']).toBe('Test Stake');

    // Elders Quorum Presidents: opt-in, so absent reads off.
    const eq = page.getByTestId('config-eq-president-access');
    await expect(eq).toHaveAttribute('aria-checked', 'false');
    await eq.click();
    await expect(async () => {
      expect((await readStake())?.['eq_president_app_access']).toBe(true);
    }).toPass();
    expect((await readStake())?.['notifications_enabled']).toBe(false);
  });

  test('Save config leaves the sliders alone, so a flip is not reverted by a later Save', async ({
    page,
  }) => {
    await seedReminderRow(true);
    await signInAsManager(page, 'mgr-save@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    await page.getByTestId('config-eq-president-access').click();
    await expect(async () => {
      expect((await readStake())?.['eq_president_app_access']).toBe(true);
    }).toPass();
    // Decline the backfill offer the flip raises; it is a separate action.
    await page.getByTestId('config-eq-backfill-cancel').click();

    await page.getByRole('button', { name: /^Save config$/ }).click();
    await expect(page.getByText('Config saved.')).toBeVisible();

    const stake = await readStake();
    expect(stake?.['eq_president_app_access']).toBe(true);
    // The reminder row is a different document entirely and Save never
    // reaches it.
    expect((await readReminderRow())?.['enabled']).toBe(true);
  });

  test('the sync reminder sits under Email Notifications Enabled, indented', async ({ page }) => {
    await seedReminderRow(false);
    await signInAsManager(page, 'mgr-order@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    const rows = page.getByTestId('config-toggles').locator('.kd-setting-toggle');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'config-notifications-enabled-row');
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'config-sync-reminder-row');
    await expect(rows.nth(2)).toHaveAttribute('data-testid', 'config-eq-president-access-row');
    await expect(rows.nth(1)).toHaveClass(/kd-setting-toggle--sub/);

    // The indent is real geometry, not just a class.
    const parent = await rows.nth(0).boundingBox();
    const child = await rows.nth(1).boundingBox();
    expect(child!.x).toBeGreaterThan(parent!.x);
  });

  test('shows a placeholder, never an off switch, before its snapshot lands', async ({ page }) => {
    // The stake doc gates this tab's render, so the reminder row is on
    // screen before `stakeSchedules/{stakeId}` arrives — every manager
    // hits this frame on every load. Rendering a disabled, unchecked
    // switch there would show a settled "off" for a reminder that is on.
    await seedReminderRow(true);
    await signInAsManager(page, 'mgr-sr-pending@example.com');

    // Sample from the first frame the row exists in, so the assertion
    // lands on what was actually painted rather than on the settled state.
    await page.addInitScript(() => {
      const w = window as unknown as { __FRAMES__: string[] };
      w.__FRAMES__ = [];
      const tick = () => {
        const row = document.querySelector('[data-testid="config-sync-reminder-row"]');
        if (row) {
          const sw = row.querySelector('[role="switch"]');
          const frame = sw
            ? `switch:${sw.getAttribute('aria-checked')}:${sw.hasAttribute('disabled')}`
            : 'placeholder';
          if (w.__FRAMES__[w.__FRAMES__.length - 1] !== frame) w.__FRAMES__.push(frame);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.goto(`/manager/configuration?tab=config`);
    await expect(page.getByTestId('config-sync-reminder-enabled')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const frames = await page.evaluate(
      () => (window as unknown as { __FRAMES__: string[] }).__FRAMES__,
    );
    // Whatever it painted first, it was never a switch reading off.
    expect(frames).not.toContain('switch:false:true');
    expect(frames).not.toContain('switch:false:false');
    // And it settles on the row's real value.
    expect(frames[frames.length - 1]).toBe('switch:true:false');
  });

  test('is inert, with the explanation behind the affordance, before the row is seeded', async ({
    page,
  }) => {
    await signInAsManager(page, 'mgr-sr-unseeded@example.com');
    await page.goto(`/manager/configuration?tab=config`);
    await expect(page.getByTestId('config-sync-reminder-enabled')).toBeDisabled();
    await expect(page.getByTestId('config-sync-reminder-row')).toHaveClass(
      /kd-setting-toggle--disabled/,
    );

    // A real switch, not the loading placeholder: once the snapshot has
    // landed, "never seeded" is a settled state and the control says so.
    await expect(page.getByTestId('config-sync-reminder-enabled-pending')).toHaveCount(0);
    await expect(page.getByTestId('config-sync-reminder-enabled')).toHaveAttribute(
      'aria-checked',
      'false',
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

  test('turning it back off persists', async ({ page }) => {
    await seedReminderRow(true);
    await signInAsManager(page, 'mgr-sr-off@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    const toggle = page.getByTestId('config-sync-reminder-enabled');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await expect(async () => {
      const row = await readReminderRow();
      expect(row?.['enabled']).toBe(false);
    }).toPass();
  });

  test('is greyed and locked, but still shows its own state, when the email switch is off', async ({
    page,
  }) => {
    // `notifications_enabled: false` suppresses the reminder email in
    // `EmailService` but not the push, and never changes the row's own
    // `enabled`. So the slider greys out — you cannot change it — while
    // still reading ON, because it is still running.
    await seedReminderRow(true);
    await signInAsManager(page, 'mgr-sr-blocked@example.com', { notifications_enabled: false });
    await page.goto(`/manager/configuration?tab=config`);

    const toggle = page.getByTestId('config-sync-reminder-enabled');
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('config-sync-reminder-row')).toHaveClass(
      /kd-setting-toggle--disabled/,
    );

    // Nothing wrote `enabled: false` on the way past.
    expect((await readReminderRow())?.['enabled']).toBe(true);
  });
});

// A real touch context: `devices['Desktop Chrome']` has no touch, and
// `.tap()` is the whole point here — the "i" affordance exists because
// managers open this page on a phone and an iPad, where nothing hovers.
test.describe('Config tab sliders on a touch phone', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('every slider’s tooltip opens by tap, and the stack fits 375px', async ({ page }) => {
    await seedReminderRow(false);
    await signInAsManager(page, 'mgr-sr-mobile@example.com');
    await page.goto(`/manager/configuration?tab=config`);

    for (const testId of [
      'config-notifications-enabled',
      'config-sync-reminder',
      'config-eq-president-access',
    ]) {
      await page.getByTestId(`${testId}-info`).tap();
      await expect(page.getByTestId(`${testId}-info-panel`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`${testId}-info-panel`)).toHaveCount(0);
    }

    const toggle = page.getByTestId('config-sync-reminder-enabled');
    await expect(toggle).toBeVisible();
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The stack must not push the page into a horizontal scroll.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflows).toBe(false);
  });
});
