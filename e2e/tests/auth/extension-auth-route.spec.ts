// `/auth/extension` — the sign-in handoff the Chrome extension opens
// inside `chrome.identity.launchWebAuthFlow` (spec §4.1). Per-page E2E
// coverage required by `e2e/CLAUDE.md`.
//
// Proofs, in order of how much they matter:
//   1. A signed-in visit whose `redirect_uri` is hostile — or merely
//      belongs to a DIFFERENT extension — renders the terminal error and
//      never leaves the origin. The redirect is what would hand a
//      session token away, so refusing to emit it is the boundary.
//   2. Nothing is minted without a click, so a background
//      `launchWebAuthFlow({ interactive: false })` cannot harvest a
//      token from a signed-in manager.
//   3. Clicking through does hand back a real `#token=` — asserted
//      strictly, because this is the ONLY test in the repo that crosses
//      the SPA-to-callable wire over HTTPS. The functions suite calls
//      the callable via `.run()` (no HTTPS layer) and the route's unit
//      tests mock the hook, so a typo'd callable name or a dropped
//      export from `functions/src/index.ts` is invisible everywhere
//      else and ships green. Accepting `#error=mint_failed` here would
//      re-open exactly that hole.
//   4. Anonymous visit renders BOTH providers, unswallowed by any auth
//      gate — the whole point is that a manager with no Google account
//      can sign in here.

import { expect, test, type Page } from '@playwright/test';
import { clearAuth, clearFirestore, createAuthUser } from '../../fixtures/emulator';

const TEST_PASSWORD = 'test-password-12345';

// The published extension's ID — mirrored from `CHROME_EXTENSION_ID` in
// `apps/web/src/lib/links.ts`, which is the source of truth and the
// default entry in the route's allowlist. The e2e workspace can't import
// app code (`rootDir` excludes it), so this is a copy; if the two ever
// drift, the route refuses the redirect and every test below fails
// loudly rather than silently passing against the wrong identity.
const EXTENSION_ID = 'klkkpfdafbjebccodmgkogdklachelpb';
const VALID_REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/`;

// Well-formed callback origin belonging to some other extension in the
// profile. Shape validation alone admits it; the allowlist must not.
const UNTRUSTED_REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';

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

  test('another extension in the profile cannot use this route, even signed in', async ({
    page,
  }) => {
    await createAuthUser({ email: 'manager3@example.com' });
    await page.goto('/');
    const appOrigin = new URL(page.url()).origin;
    await signInViaTestHatch(page, 'manager3@example.com');

    await page.goto(routeUrl(UNTRUSTED_REDIRECT));

    await expect(page.getByTestId('extension-auth-error')).toBeVisible();
    // No confirm step is offered, so there is nothing to click through.
    await expect(page.getByTestId('extension-connect')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(new URL(page.url()).origin).toBe(appOrigin);
  });

  // The `interactive: false` harvest. A background flow renders no UI,
  // so it can never press the confirm — which is why the page must sit
  // still here rather than minting on arrival.
  test('a signed-in visit mints nothing until the confirm is pressed', async ({ page }) => {
    await createAuthUser({ email: 'manager4@example.com' });
    await page.goto(routeUrl(VALID_REDIRECT));
    await signInViaTestHatch(page, 'manager4@example.com');

    await expect(page.getByTestId('extension-connect')).toBeVisible();
    // The account being handed over is named, so a profile signed in as
    // someone else is visible before anything is minted.
    await expect(page.getByTestId('extension-connect')).toContainText('manager4@example.com');

    await page.waitForTimeout(1000);
    expect(new URL(page.url()).pathname).toBe('/auth/extension');
  });

  test('pressing the confirm hands the extension a real token on the URL fragment', async ({
    page,
  }) => {
    await createAuthUser({ email: 'manager2@example.com' });
    await page.goto(routeUrl(VALID_REDIRECT));
    await signInViaTestHatch(page, 'manager2@example.com');

    await page.getByRole('button', { name: /^Connect the extension$/ }).click();
    await page.waitForURL(CALLBACK_ORIGIN_PATTERN, { timeout: 15_000 });

    const handed = new URL(page.url());
    expect(handed.origin).toBe(`https://${EXTENSION_ID}.chromiumapp.org`);
    // Everything rides the fragment — a query string would put the
    // token in server logs and Referer headers.
    expect(handed.search).toBe('');
    // Strictly `#token=` — see the header. `#error=mint_failed` here
    // means the callable is unreachable, which is a real failure and
    // must not be tolerated by the one test that can see it.
    expect(handed.hash).toMatch(/^#token=.+/);
    // A Firebase custom token is a JWT: three base64url segments.
    const token = decodeURIComponent(handed.hash.slice('#token='.length));
    expect(token.split('.')).toHaveLength(3);
  });
});
