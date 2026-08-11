// `/auth/extension` — sign-in handoff for the Chrome extension
// (spec §4.1). The extension opens this route inside a
// `chrome.identity.launchWebAuthFlow` window; the SPA signs the user in
// with whichever provider they have (a Kindoo Manager may hold no
// Google account at all, which is what the extension's Google-only
// path could not serve), mints a Firebase custom token, and hands it
// back on the fragment of the extension's own redirect URI. The
// extension exchanges it via `signInWithCustomToken` for its own
// session.
//
// Unauthed by design — the whole point is the signed-out entry — so the
// route sits beside `auth/email-link` rather than under `_authed`.
//
// Handoff shapes, both on the fragment and never on a query string, so
// neither value reaches a server log or a Referer header:
//   - success: `<redirect_uri>#token=<encodeURIComponent(customToken)>`
//   - failure: `<redirect_uri>#error=mint_failed`
//
// Cancellation has no shape at all: if the user closes the window we
// simply never redirect, and `launchWebAuthFlow` rejects on its own.

import { useEffect, useRef } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { BrandIcon } from '../../components/layout/BrandIcon';
import { SignInProviders } from '../../features/auth/SignInProviders';
import { useSignInForm } from '../../features/auth/useSignInForm';
import { useAuthReady, useMintExtensionToken } from '../../features/auth/hooks';
import { usePrincipal } from '../../lib/principal';
import { CHROME_WEB_STORE_URL } from '../../lib/links';

/**
 * The only class of redirect target that may ever receive a token: a
 * Chrome extension's own `launchWebAuthFlow` callback origin, whose
 * host is the 32-character extension ID (alphabet `a`–`p`) under
 * `chromiumapp.org`. No path, no query, optional trailing slash.
 *
 * This check is the whole security boundary of the route — everything
 * downstream trusts that the fragment lands in the extension that
 * opened us. A `redirect_uri` that does not match gets a terminal error
 * state and NO redirect of any kind.
 */
export const REDIRECT_URI_PATTERN = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/?$/;

const extensionSearchSchema = z
  .object({ redirect_uri: z.string() })
  // A missing or non-string param degrades to `''` rather than
  // throwing. `''` fails the pattern, so it lands in the same terminal
  // error state as a hostile value; throwing would surface the
  // router's error boundary instead, which tells the user nothing and
  // hides the one message that helps them.
  .catch({ redirect_uri: '' });

export type ExtensionAuthSearch = z.infer<typeof extensionSearchSchema>;

export const Route = createFileRoute('/auth/extension')({
  validateSearch: (raw): ExtensionAuthSearch => extensionSearchSchema.parse(raw),
  component: ExtensionAuthPage,
});

function ExtensionAuthPage() {
  const { redirect_uri: redirectUri } = Route.useSearch();
  const redirectAllowed = REDIRECT_URI_PATTERN.test(redirectUri);

  const principal = usePrincipal();
  const authReady = useAuthReady();
  const signedIn = principal.firebaseAuthSignedIn;
  const signIn = useSignInForm();
  const { mutateAsync: mintExtensionToken } = useMintExtensionToken();

  // One mint per mount. StrictMode double-invokes effects in dev, and
  // the signed-in branch is reached by a state change (auth hydrating,
  // or a provider resolving) that can fire more than once.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!redirectAllowed || !authReady || !signedIn || startedRef.current) return;
    startedRef.current = true;
    mintExtensionToken()
      .then((token) => {
        window.location.replace(`${redirectUri}#token=${encodeURIComponent(token)}`);
      })
      .catch(() => {
        window.location.replace(`${redirectUri}#error=mint_failed`);
      });
  }, [redirectAllowed, authReady, signedIn, redirectUri, mintExtensionToken]);

  return (
    <div className="flex min-h-screen flex-col bg-[#f7f8fb] text-[color:var(--kd-fg-1)]">
      <header className="border-b border-[color:var(--kd-chrome-border)] bg-white">
        <div className="mx-auto flex w-full max-w-md items-center gap-2.5 px-5 py-3 text-[color:var(--kd-primary)]">
          <BrandIcon size={28} />
          <span className="text-base font-semibold">Stake Building Access</span>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-5 py-10">
        <div className="w-full max-w-md">
          {!redirectAllowed ? (
            <InvalidRedirectCard />
          ) : !authReady ? (
            <StatusCard title="Checking your sign-in…" body="One moment." />
          ) : signedIn ? (
            <StatusCard
              title="Connecting the extension…"
              body="Signing the extension in as you. This window closes on its own."
            />
          ) : (
            <>
              <div className="mb-5">
                <h1 className="m-0 text-[1.15rem] font-semibold text-[color:var(--kd-fg-1)]">
                  Sign in to connect the extension
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
                  Use whichever sign-in you already use for Stake Building Access. A Google account
                  is not required.
                </p>
              </div>
              <SignInProviders
                state={signIn}
                note={<MagicLinkNote />}
                confirmationBody="Open it in your browser, then come back to Kindoo and press Sign in in the extension again."
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// The magic-link wrinkle, stated as an instruction rather than an
// error: the emailed link opens in an ordinary browser tab, not in this
// `launchWebAuthFlow` window, so it can't complete the handoff from
// there. By the time the user re-runs the flow, Firebase Auth has the
// session persisted on this origin, so the second pass sees a signed-in
// user and mints immediately with nothing to fill in.
function MagicLinkNote() {
  return (
    <div
      data-testid="extension-magic-link-note"
      className="rounded border border-[color:var(--kd-border-soft)] bg-white p-4 text-sm leading-relaxed text-[color:var(--kd-fg-2)]"
    >
      <strong className="font-semibold text-[color:var(--kd-fg-1)]">Using a sign-in link?</strong>{' '}
      The email opens in a normal browser tab, not this window — that&rsquo;s expected. Click the
      link there, then come back to Kindoo and press <strong>Sign in</strong> in the extension
      again. It will finish without asking you anything else.
    </div>
  );
}

interface StatusCardProps {
  title: string;
  body: string;
}

function StatusCard({ title, body }: StatusCardProps) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded border border-[color:var(--kd-border-soft)] bg-white p-6 text-center"
    >
      <h1 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-fg-1)]">{title}</h1>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">{body}</p>
    </div>
  );
}

// Terminal state for a `redirect_uri` that isn't an extension callback
// origin. No affordance leads anywhere — offering a "continue anyway"
// would defeat the check.
function InvalidRedirectCard() {
  return (
    <div
      role="alert"
      data-testid="extension-auth-error"
      className="flex flex-col gap-3 rounded border border-[color:var(--kd-danger-tint)] bg-white p-6"
    >
      <h1 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-danger-fg)]">
        This window can&rsquo;t return a sign-in.
      </h1>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        It was opened without a valid return address for the extension, so we won&rsquo;t sign
        anything in from here.
      </p>
      <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
        Close this window and start again from the extension. If it keeps happening, reinstall{' '}
        <a
          href={CHROME_WEB_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--kd-primary)] hover:underline"
        >
          Stake Building Access &mdash; Kindoo Helper
        </a>{' '}
        from the Chrome Web Store.
      </p>
    </div>
  );
}
