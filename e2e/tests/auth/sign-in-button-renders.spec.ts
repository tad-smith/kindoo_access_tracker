// Regression spec for the Phase-5 SignInPage button. Phase 5 (T-18)
// added Tailwind v4 + its preflight reset, which silently stripped the
// browser-default chrome from the bare `<button>` that Phase 2 shipped:
// `background-color` collapsed to `transparent`, `border` to `0`, and
// `padding` to `0`, leaving "Sign in with Google" rendered as plain
// text. The unit test still passed because RTL/jsdom doesn't apply
// CSS, and the existing auth-flow E2E spec only asserted role +
// accessible name (which preflight doesn't change).
//
// What this spec catches: the button renders with a NON-transparent
// background colour and a NON-zero padding box. That's the cheapest
// real-DOM check that the styled `.btn` class is in play. If a future
// PR routes SignInPage through some other primitive that loses its
// styling, this fails fast.
//
// We hit the SignInPage anonymously (no sign-in needed) — the page
// renders synchronously on mount; no emulator state is required.

import { expect, test } from '@playwright/test';

test.describe('SignInPage button renders as a styled, clickable button', () => {
  test('"Sign in with Google" has visible chrome (background, padding)', async ({ page }) => {
    await page.goto('/');

    const button = page.getByRole('button', { name: /Sign in with Google/i });
    await expect(button).toBeVisible();

    // Non-zero bounding box — preflight on a bare `<button>` with empty
    // padding still shows the text, but the button-shaped chrome is
    // gone. We assert the box is at least a few px tall AND contains
    // padding (the `.btn` class adds 6px×12px padding).
    const box = await button.boundingBox();
    expect(box, 'button must have a layout box').not.toBeNull();
    if (!box) return;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);

    // Computed style snapshot. Tailwind preflight resets bare buttons
    // to `background-color: transparent`, `border-width: 0`, `padding:
    // 0`. The `.btn` class restores blue background + 6px×12px padding.
    // Asserting on those three is the precise regression contract.
    const styles = await button.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        paddingTop: cs.paddingTop,
        paddingLeft: cs.paddingLeft,
        cursor: cs.cursor,
      };
    });

    // Background must be a real colour — not transparent, not the
    // page background bleeding through.
    expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.backgroundColor).not.toBe('transparent');

    // `.btn` sets `padding: 6px 12px`. Anything > 0 catches the
    // preflight-zeroed regression; the exact values would over-fit.
    expect(parseFloat(styles.paddingTop)).toBeGreaterThan(0);
    expect(parseFloat(styles.paddingLeft)).toBeGreaterThan(0);

    // `.btn` sets `cursor: pointer` so the button reads as
    // interactive. Bare-button-after-preflight resolves to `default`.
    expect(styles.cursor).toBe('pointer');
  });
});
