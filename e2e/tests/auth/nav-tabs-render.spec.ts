// Regression spec for the Phase-5 Nav. The nav links are intended to
// render as a tab bar (text-link affordance with a bottom-border
// accent on the active route), not as button-pill controls. Phase 5's
// Tailwind/shadcn-ui bootstrap left `Nav.css` styling each link as a
// bordered, rounded pill — visually a button, contradicting the
// migration plan §Phase 4 ("Nav.tsx — role-aware links generated from
// principal claims. Active route highlighted.") and the Apps Script
// reference at `src/ui/Styles.html` `.nav-link` (folder-tab visual,
// no boxy chrome on inactive items).
//
// What this spec catches: the styled chrome of inactive links + the
// underline-style accent on the active link. Three computed-style
// assertions that fail fast if a future PR routes the nav through a
// shadcn `<Button>` primitive or pill-styled wrapper:
//
//   1. Inactive links have NO opaque background fill (a button-pill
//      would set one — `.btn` ships with `--kd-primary` blue, the
//      Phase-5 regression set `--kd-surface-alt` on hover via
//      `border-radius: 4px` chrome).
//   2. Inactive links have NO non-zero border-radius (a button pill
//      has 4px+ rounding all around; tabs do not).
//   3. The active link has a non-zero `border-bottom-width` rendered
//      in the brand-primary color — that's the tab-active accent the
//      Apps Script visual provides, and the cheapest CSS-level proof
//      the link reads as a tab.
//
// Auth required (the Shell only renders the Nav for authenticated
// principals); we use the same `signInViaTestHatch` choreography as
// the other auth-flow specs.

import { expect, test, type Page } from '@playwright/test';
import {
  clearAuth,
  clearFirestore,
  createAuthUser,
  setCustomClaims,
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

test.describe('Nav links render as tabs, not buttons', () => {
  test.beforeEach(async () => {
    await clearAuth();
    await clearFirestore();
  });

  test('inactive links have no button-pill chrome and the active link has a brand-color bottom-border accent', async ({
    page,
  }) => {
    await signInAsManager(page, 'nav-tabs@example.com');
    // Manager defaults to /manager/dashboard; "Dashboard" is the
    // active link, the rest are inactive.
    await expect(page.getByRole('heading', { name: /^Dashboard$/ })).toBeVisible();

    const activeLink = page.getByRole('link', { name: /^Dashboard$/ });
    const inactiveLink = page.getByRole('link', { name: /^All Seats$/ });
    await expect(activeLink).toBeVisible();
    await expect(inactiveLink).toBeVisible();

    // ----- Inactive link: no button-pill chrome ---------------------

    const inactiveStyles = await inactiveLink.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        backgroundColor: cs.backgroundColor,
        borderTopLeftRadius: cs.borderTopLeftRadius,
        borderTopRightRadius: cs.borderTopRightRadius,
        borderBottomLeftRadius: cs.borderBottomLeftRadius,
        borderBottomRightRadius: cs.borderBottomRightRadius,
      };
    });

    // Inactive must NOT have an opaque background fill. The Phase-5
    // regression had the active link filled with `--kd-primary-tint`
    // and inactive links with `--kd-surface-alt` on hover; both are
    // button-pill affordances. The tab style is transparent.
    expect(inactiveStyles.backgroundColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);

    // Inactive must NOT have rounded all-around corners. Pre-fix CSS
    // had `border-radius: 4px` on every link; tabs are right-angled
    // (or only top-rounded for the folder-tab variant — neither has
    // bottom-rounded corners).
    expect(parseFloat(inactiveStyles.borderBottomLeftRadius)).toBe(0);
    expect(parseFloat(inactiveStyles.borderBottomRightRadius)).toBe(0);

    // ----- Active link: brand-color bottom-border accent ------------

    const activeStyles = await activeLink.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return {
        color: cs.color,
        borderBottomWidth: cs.borderBottomWidth,
        borderBottomColor: cs.borderBottomColor,
        backgroundColor: cs.backgroundColor,
      };
    });

    // The bottom-border accent is the tab-active indicator. Must be
    // non-zero AND must NOT be transparent — Phase-5 had a 1px
    // transparent border on every link, which fails this check.
    expect(parseFloat(activeStyles.borderBottomWidth)).toBeGreaterThan(0);
    expect(activeStyles.borderBottomColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(activeStyles.borderBottomColor).not.toBe('transparent');

    // The accent (and active text color) is the brand primary
    // (`--kd-primary` = `#2b6cb0`). We assert via computed RGB so a
    // future palette tweak doesn't churn this test — `2b6cb0` is the
    // canonical brand blue from `tokens.css`.
    const expectedPrimary = 'rgb(43, 108, 176)';
    expect(activeStyles.borderBottomColor).toBe(expectedPrimary);
    expect(activeStyles.color).toBe(expectedPrimary);

    // Active link is also flat — no opaque background fill (Phase-5
    // regression filled the active link with `--kd-primary-tint`,
    // which made it look like a selected button).
    expect(activeStyles.backgroundColor).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
  });
});
