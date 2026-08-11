// `/auth/extension` — the sign-in handoff the Chrome extension opens
// inside `chrome.identity.launchWebAuthFlow` (spec §4.1). Per-page E2E
// coverage required by `e2e/CLAUDE.md`.
//
// Three proofs, all of them about the boundary rather than the happy
// mint (whose token value is the extension's problem, not the SPA's):
//   1. Anonymous visit with a legitimate `redirect_uri` renders BOTH
//      providers, unswallowed by any auth gate — the whole point of the
//      route is that a Kindoo Manager with no Google account can sign
//      in here.
//   2. A signed-in visit with a hostile `redirect_uri` renders the
//      terminal error and NEVER leaves the origin. This is the one that
//      matters: the redirect is what would hand a session token to an
//      arbitrary origin.
//   3. A signed-in visit with a legitimate `redirect_uri` does leave,
//      to the extension's callback, carrying its payload on the
//      fragment and nothing in the query string.
//
// (3) deliberately accepts either `#token=` or `#error=mint_failed`:
// whether the `mintExtensionToken` callable is deployed into the
// emulator is a backend concern, and both outcomes prove the same
// SPA-side contract — the handoff goes out on the fragment.

import { expect, test, type Page } from '@playwright/test';
import { clearAuth, clearFirestore, createAuthUser } from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

// A syntactically valid Chrome extension callback origin: 32 chars from
// the `a`–`p` alphabet. Not a real published extension ID.
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const VALID_REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/`;

/** Matches the callback origin only as a URL, never as a substring of one. */
const CALLBACK_ORIGIN_PATTERN = /^https:\/\/[a-p]{32}\.chromiumapp\.org\//;

/** Drive the SPA's Auth-emulator-only sign-in hatch (see auth-flow.spec.ts). */
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

function routeUrl(redirectUri: string): string {
  return `/auth/extension?redirect_uri=${encodeURIComponent(redirectUri)}`;
}

test.describe('/auth/extension', () => {
  test.beforeEach(async ({ page }) => {
    await clearAuth();
    await clearFirestore();
    // `*.chromiumapp.org` resolves nowhere outside a real extension
    // window. Fulfil it locally so a redirect lands on a real document
    // and the resulting URL (fragment included) is readable.
    //
    // Anchored at `^https://` deliberately: an unanchored
    // /chromiumapp\.org/ also matches the SPA's own URL, whose query
    // string carries the redirect target percent-encoded — which
    // leaves the host name literal. That serves this stub in place of
    // the app and every assertion below fails against a blank page.
    await page.route(CALLBACK_ORIGIN_PATTERN, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>extension callback</title>',
      }),
    );
  });

  test('anonymous visit offers both sign-in providers and explains the emailed-link detour', async ({
    page,
  }) => {
    await page.goto(routeUrl(VALID_REDIRECT));

    // Not swallowed by the `/` auth gate — the sign-in affordances are
    // the point of the page while signed out.
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
    await expect(page.getByLabel(/Email address/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Send me a sign-in link/i })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    const note = page.getByTestId('extension-magic-link-note');
    await expect(note).toContainText(/normal browser tab, not this window/i);
    await expect(note).toContainText(/press Sign in in the extension again/i);

    // Still on the SPA — nothing to hand back yet.
    expect(page.url()).toContain('/auth/extension');
  });

  test('mobile viewport (375x812) keeps both providers usable without horizontal scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(routeUrl(VALID_REDIRECT));

    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Send me a sign-in link/i })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('a redirect_uri outside the extension callback origin is refused and never redirected to', async ({
    page,
  }) => {
    await createAuthUser({ email: 'manager@example.com' });
    // Sign in away from this route: landing on it with a legitimate
    // redirect_uri would hand off and navigate away mid-sign-in.
    await page.goto('/');
    const appOrigin = new URL(page.url()).origin;
    await signInViaTestHatch(page, 'manager@example.com');

    // Signed in, so the mint-and-hand-back branch is live — then load
    // the route pointed at somewhere else entirely.
    await page.goto(routeUrl('https://evil.example.com/'));

    await expect(page.getByTestId('extension-auth-error')).toBeVisible();
    // No affordance out of the terminal state, and above all no
    // navigation: the token never leaves the origin. Assert on the
    // origin rather than on the absence of the hostile host in the URL
    // — it legitimately appears there, as the query param we refused.
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toHaveCount(0);
    await page.waitForTimeout(500);
    const stillHere = new URL(page.url());
    expect(stillHere.origin).toBe(appOrigin);
    expect(stillHere.pathname).toBe('/auth/extension');
  });

  test('a signed-in visit hands the extension its payload on the URL fragment', async ({
    page,
  }) => {
    await createAuthUser({ email: 'manager2@example.com' });
    await page.goto(routeUrl(VALID_REDIRECT));
    await signInViaTestHatch(page, 'manager2@example.com');

    await page.waitForURL(CALLBACK_ORIGIN_PATTERN, { timeout: 15_000 });

    const handed = new URL(page.url());
    expect(handed.origin).toBe(`https://${EXTENSION_ID}.chromiumapp.org`);
    // Everything rides the fragment — a query string would put the
    // token in server logs and Referer headers.
    expect(handed.search).toBe('');
    expect(handed.hash).toMatch(/^#(token=.+|error=mint_failed)$/);
  });
});
