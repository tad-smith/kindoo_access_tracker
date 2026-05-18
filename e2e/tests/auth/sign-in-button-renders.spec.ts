// Regression spec for the SignInPage. Phase 5 (T-18) added Tailwind v4
// + its preflight reset, which silently stripped the browser-default
// chrome from the bare `<button>` that Phase 2 shipped: `background-
// color` collapsed to `transparent`, `border` to `0`, and `padding` to
// `0`, leaving the CTA rendered as plain text. The unit test still
// passed because RTL/jsdom doesn't apply CSS, and the existing auth-flow
// E2E spec only asserted role + accessible name (which preflight doesn't
// change).
//
// The SignInPage surfaces both providers (spec §4.1): a "Continue with
// Google" CTA above the email magic-link form. The regression contract
// is unchanged for either primary button: it must render with a
// NON-transparent background colour and a NON-zero padding box. That's
// the cheapest real-DOM check that the styled `.btn` class is in play.
//
// Also asserts the three sign-in affordances ("Continue with Google",
// "Send me a sign-in link", and the topbar "Sign in") resolve
// unambiguously under Playwright's strict-mode `getByRole` — distinct
// accessible names so they are not confused with each other.

import { expect, test } from '@playwright/test';

test.describe('SignInPage form renders as styled, clickable controls', () => {
  test('"Continue with Google" has visible chrome (background, padding)', async ({ page }) => {
    await page.goto('/');

    const google = page.getByRole('button', { name: /Continue with Google/i });
    await expect(google).toBeVisible();

    const box = await google.boundingBox();
    expect(box, 'button must have a layout box').not.toBeNull();
    if (!box) return;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);

    const styles = await google.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        paddingTop: cs.paddingTop,
        paddingLeft: cs.paddingLeft,
        cursor: cs.cursor,
      };
    });

    expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.backgroundColor).not.toBe('transparent');
    expect(parseFloat(styles.paddingTop)).toBeGreaterThan(0);
    expect(parseFloat(styles.paddingLeft)).toBeGreaterThan(0);
    expect(styles.cursor).toBe('pointer');
  });

  test('"Send me a sign-in link" has visible chrome (background, padding)', async ({ page }) => {
    await page.goto('/');

    const submit = page.getByRole('button', { name: /Send me a sign-in link/i });
    await expect(submit).toBeVisible();

    // Non-zero bounding box — preflight on a bare `<button>` with empty
    // padding still shows the text, but the button-shaped chrome is
    // gone. We assert the box is at least a few px tall AND contains
    // padding (the `.btn` class adds 6px×12px padding).
    const box = await submit.boundingBox();
    expect(box, 'button must have a layout box').not.toBeNull();
    if (!box) return;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);

    // Computed style snapshot. Tailwind preflight resets bare buttons
    // to `background-color: transparent`, `border-width: 0`, `padding:
    // 0`. The `.btn` class restores blue background + 6px×12px padding.
    // Asserting on those three is the precise regression contract.
    const styles = await submit.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        paddingTop: cs.paddingTop,
        paddingLeft: cs.paddingLeft,
        cursor: cs.cursor,
      };
    });

    expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.backgroundColor).not.toBe('transparent');
    expect(parseFloat(styles.paddingTop)).toBeGreaterThan(0);
    expect(parseFloat(styles.paddingLeft)).toBeGreaterThan(0);
    expect(styles.cursor).toBe('pointer');
  });

  test('Google, magic-link, and topbar Sign in affordances resolve unambiguously', async ({
    page,
  }) => {
    await page.goto('/');

    // Google CTA — sits above the magic-link form per spec §4.1.
    const google = page.getByRole('button', { name: /Continue with Google/i });
    await expect(google).toBeVisible();

    // Hero magic-link CTA — primary submit. Distinct name keeps
    // Playwright's strict-mode getByRole happy.
    const hero = page.getByRole('button', { name: /Send me a sign-in link/i });
    await expect(hero).toBeVisible();

    // Topbar "Sign in" — secondary affordance, distinct accessible
    // name (`^Sign in$` matches the topbar but not the hero submits).
    const topbar = page.getByRole('button', { name: /^Sign in$/ });
    await expect(topbar).toBeVisible();
  });

  test('renders the email input and the new-user explanatory sentence', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
    await expect(
      page.getByText(
        /New sign-ins land in pending authorization until a stake manager adds your email\./i,
      ),
    ).toBeVisible();
  });
});
