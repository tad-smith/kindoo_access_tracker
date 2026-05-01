// Phase 10.1 navigation-redesign E2E. Exercises the breakpoint-gated
// nav surfaces:
//   - Desktop (>=1024px): persistent left rail, all items + labels.
//   - Tablet (640–1023px): icons-only rail; tap → floating panel.
//   - Phone (<640px): hamburger → drawer.
// Plus the resize-crossing behavior (§13): crossing a breakpoint
// closes any open nav UI.

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

async function signInAsManager(page: Page, email: string): Promise<void> {
  const { uid } = await createAuthUser({ email });
  await setCustomClaims(uid, {
    canonical: email,
    stakes: {
      csnorth: { manager: true, stake: false, wards: [] },
    },
  });
  await page.goto('/');
  await signInViaTestHatch(page, email, TEST_PASSWORD);
}

test.describe('Phase 10.1 navigation redesign', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
    await writeDoc('stakes/csnorth', {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: true,
    });
  });

  test('desktop: persistent left rail with sectioned nav + sign-out in foot', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInAsManager(page, 'desktop-rail@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Left rail visible.
    const rail = page.locator('.kd-left-rail');
    await expect(rail).toBeVisible();

    // All section headers render.
    await expect(rail.getByRole('heading', { name: 'Quick Links' })).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Rosters' })).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Manager-side full nav-item set is visible (sample a few).
    await expect(rail.getByRole('link', { name: /Dashboard/ })).toBeVisible();
    await expect(rail.getByRole('link', { name: /Audit Log/ })).toBeVisible();
    await expect(rail.getByRole('link', { name: /All Seats/ })).toBeVisible();

    // Logout pinned to the rail's foot.
    await expect(rail.getByRole('button', { name: /sign out/i })).toBeVisible();
    // Brand bar carries no logout button.
    const brandbar = page.locator('.kd-brandbar');
    await expect(brandbar.getByRole('button', { name: /sign out/i })).toHaveCount(0);

    // No icon rail, no drawer, no panel.
    await expect(page.locator('.kd-icon-rail')).toHaveCount(0);
    await expect(page.locator('.kd-nav-overlay')).toHaveCount(0);
  });

  test('tablet: icons-only rail; tap icon navigates directly (no panel)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await signInAsManager(page, 'tablet-icon-nav@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Icons rail visible; persistent desktop rail not.
    await expect(page.locator('.kd-icon-rail')).toBeVisible();
    await expect(page.locator('.kd-left-rail')).toHaveCount(0);

    // Tap an icon (All Seats) → navigates directly; no overlay opens.
    const iconRail = page.locator('.kd-icon-rail');
    await iconRail.getByRole('link', { name: /All Seats/ }).click();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
    await expect(page.locator('.kd-nav-overlay-panel')).toHaveCount(0);
  });

  test('tablet: clicking a non-icon area expands the rail; backdrop + Escape collapse it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await signInAsManager(page, 'tablet-expand@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const iconRail = page.locator('.kd-icon-rail');
    await expect(iconRail).toBeVisible();

    // Click a section divider (a non-icon hit-target) → rail expands.
    await iconRail.locator('.kd-icon-rail-divider').first().click();
    await expect(page.locator('.kd-nav-overlay-panel')).toBeVisible();
    await expect(
      page.locator('.kd-nav-overlay-panel').getByRole('heading', { name: 'Quick Links' }),
    ).toBeVisible();

    // Backdrop tap collapses.
    await page.getByTestId('nav-overlay-backdrop').click();
    await expect(page.locator('.kd-nav-overlay-panel')).toHaveCount(0);

    // Re-expand by clicking a non-icon area.
    await iconRail.locator('.kd-icon-rail-divider').first().click();
    await expect(page.locator('.kd-nav-overlay-panel')).toBeVisible();

    // Escape collapses.
    await page.keyboard.press('Escape');
    await expect(page.locator('.kd-nav-overlay-panel')).toHaveCount(0);
  });

  test('tablet: dragging the rail rightward past threshold expands it', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await signInAsManager(page, 'tablet-drag@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const iconRail = page.locator('.kd-icon-rail');
    const railBox = await iconRail.boundingBox();
    if (!railBox) throw new Error('icon rail had no bounding box');

    // Drag from inside the rail (use the foot area to avoid hitting an
    // icon button) rightward by 80px (well past the 32px threshold).
    const startX = railBox.x + railBox.width / 2;
    const startY = railBox.y + railBox.height - 30;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator('.kd-nav-overlay-panel')).toBeVisible();
  });

  test('tablet: tapping a labeled item in the expanded rail navigates + collapses', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await signInAsManager(page, 'tablet-expand-nav@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Expand via non-icon area.
    await page.locator('.kd-icon-rail .kd-icon-rail-divider').first().click();
    const panel = page.locator('.kd-nav-overlay-panel');
    await expect(panel).toBeVisible();

    // Tap All Seats inside the expanded rail → navigates + collapses.
    await panel.getByRole('link', { name: /All Seats/ }).click();
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
    await expect(page.locator('.kd-nav-overlay-panel')).toHaveCount(0);
  });

  test('phone: hamburger opens drawer; nav-item tap closes drawer + navigates', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAsManager(page, 'phone-drawer@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // No persistent rail; brand bar has the hamburger.
    await expect(page.locator('.kd-left-rail')).toHaveCount(0);
    await expect(page.locator('.kd-icon-rail')).toHaveCount(0);
    const hamburger = page.getByRole('button', { name: /open navigation/i });
    await expect(hamburger).toBeVisible();

    // Open the drawer.
    await hamburger.click();
    const drawer = page.locator('.kd-nav-overlay-drawer');
    await expect(drawer).toBeVisible();

    // Drawer footer carries the email + sign-out + version.
    await expect(drawer.getByText('phone-drawer@example.com')).toBeVisible();
    await expect(drawer.getByRole('button', { name: /sign out/i })).toBeVisible();
    await expect(drawer.getByLabel('Build version')).toBeVisible();

    // Tap a nav item → drawer closes + navigation happens.
    await drawer.getByRole('link', { name: /All Seats/ }).click();
    await expect(page.locator('.kd-nav-overlay-drawer')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^All Seats$/ })).toBeVisible();
  });

  test('phone: backdrop tap closes the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAsManager(page, 'phone-backdrop@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    await page.getByRole('button', { name: /open navigation/i }).click();
    await expect(page.locator('.kd-nav-overlay-drawer')).toBeVisible();
    await page.getByTestId('nav-overlay-backdrop').click();
    await expect(page.locator('.kd-nav-overlay-drawer')).toHaveCount(0);
  });

  test('resize tablet → desktop with panel open: panel auto-closes; full rail takes over', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await signInAsManager(page, 'resize-t-d@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Expand the rail via a non-icon area (icon taps now navigate
    // directly; clicking a section divider opens the panel).
    await page.locator('.kd-icon-rail .kd-icon-rail-divider').first().click();
    await expect(page.locator('.kd-nav-overlay-panel')).toBeVisible();

    // Cross to desktop.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.kd-nav-overlay-panel')).toHaveCount(0);
    await expect(page.locator('.kd-left-rail')).toBeVisible();
  });

  test('resize phone → desktop with drawer open: drawer auto-closes; rail takes over', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await signInAsManager(page, 'resize-p-d@example.com');
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    // Open the drawer.
    await page.getByRole('button', { name: /open navigation/i }).click();
    await expect(page.locator('.kd-nav-overlay-drawer')).toBeVisible();

    // Cross to desktop.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.kd-nav-overlay-drawer')).toHaveCount(0);
    await expect(page.locator('.kd-left-rail')).toBeVisible();
  });
});
