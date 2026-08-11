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
//
// TWO GATES STAND BETWEEN A CALLER AND A TOKEN, and they cover
// different attacks:
//
//   1. `isAllowedRedirectUri` — the extension must be one this build
//      trusts. Shape alone is not a boundary; see `extensionRedirect.ts`.
//   2. An explicit click on "Connect the extension". Nothing is minted
//      on mount. `launchWebAuthFlow({ interactive: false })` renders no
//      UI and therefore can never produce that click, which is what
//      stops a silent background harvest even from an allowlisted ID.
//
// The click also answers a question the auto-mint could not: whose
// session is being handed over. The confirm names the account and
// offers to switch, so a profile signed in as someone else can't be
// relayed to the extension without the manager seeing whose it is.

import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { BrandIcon } from '../../components/layout/BrandIcon';
import { Button } from '../../components/ui/Button';
import { SignInProviders } from '../../features/auth/SignInProviders';
import { useSignInForm } from '../../features/auth/useSignInForm';
import { useAuthReady, useMintExtensionToken } from '../../features/auth/hooks';
import {
  extensionAllowlistIsEmpty,
  isAllowedRedirectUri,
} from '../../features/auth/extensionRedirect';
import { signOut } from '../../features/auth/signOut';
import { usePrincipal } from '../../lib/principal';
import { CHROME_WEB_STORE_URL } from '../../lib/links';

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
  const redirectAllowed = isAllowedRedirectUri(redirectUri);

  const principal = usePrincipal();
  const authReady = useAuthReady();
  const signedIn = principal.firebaseAuthSignedIn;
  // `announceCancelledPopup`: this page renders inside a
  // `launchWebAuthFlow` window, where a Google popup that never opened
  // is indistinguishable from nothing happening. Silence would leave
  // the manager with no hint that the magic-link form below works
  // without Google at all.
  const signIn = useSignInForm({ announceCancelledPopup: true });
  const { mutateAsync: mintExtensionToken } = useMintExtensionToken();
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    // Belt and braces: the button is disabled while pending, and the
    // allowlist was checked at render. Re-checking here means no future
    // refactor can reach the mint without passing the boundary.
    if (!redirectAllowed || connecting) return;
    setConnecting(true);
    try {
      const token = await mintExtensionToken();
      window.location.replace(`${redirectUri}#token=${encodeURIComponent(token)}`);
    } catch {
      window.location.replace(`${redirectUri}#error=mint_failed`);
    }
  }

  async function handleUseDifferentAccount() {
    await signOut();
    // `usePrincipal` observes `onAuthStateChanged`, so the signed-out
    // branch — the provider block — renders on its own from here.
  }

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
            <InvalidRedirectCard redirectUri={redirectUri} />
          ) : !authReady ? (
            <StatusCard title="Checking your sign-in…" body="One moment." />
          ) : signedIn ? (
            <ConnectCard
              email={principal.email}
              connecting={connecting}
              onConnect={handleConnect}
              onUseDifferentAccount={handleUseDifferentAccount}
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
                confirmationBody="Open it in your browser, then come back to Kindoo and press Sign in in the extension again to finish."
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

interface ConnectCardProps {
  email: string;
  connecting: boolean;
  onConnect: () => void;
  onUseDifferentAccount: () => void;
}

// The confirm step. Nothing is minted until this button is pressed —
// see the module header for why the click is a security boundary and
// not just a courtesy.
//
// It names the account because the browser profile, not the extension,
// decides whose session this is. A manager on a shared or family
// machine can easily be signed in as someone else here, and before this
// card existed the extension would have received that identity with
// nothing on screen to say so.
function ConnectCard({ email, connecting, onConnect, onUseDifferentAccount }: ConnectCardProps) {
  return (
    <div
      data-testid="extension-connect"
      className="flex flex-col gap-4 rounded border border-[color:var(--kd-border-soft)] bg-white p-6"
    >
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[1.15rem] font-semibold text-[color:var(--kd-fg-1)]">
          Connect the extension
        </h1>
        <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
          The Stake Building Access extension will act as{' '}
          {/* `break-words`, not `break-all`: a long address moves to its
              own line before it splits, instead of being chopped at
              whatever column the previous word ended on. */}
          <strong className="break-words font-semibold text-[color:var(--kd-fg-1)]">{email}</strong>{' '}
          until you sign out of it.
        </p>
      </div>
      <Button type="button" onClick={onConnect} disabled={connecting} className="w-full">
        {connecting ? 'Connecting…' : 'Connect the extension'}
      </Button>
      <button
        type="button"
        onClick={onUseDifferentAccount}
        disabled={connecting}
        className="self-center text-sm text-[color:var(--kd-primary)] underline-offset-2 hover:underline disabled:opacity-60"
      >
        Not you? Use a different account
      </button>
    </div>
  );
}

// The magic-link wrinkle, stated as an instruction rather than an
// error: the emailed link opens in an ordinary browser tab, not in this
// `launchWebAuthFlow` window, so it can't complete the handoff from
// there. By the time the user re-runs the flow, Firebase Auth has the
// session persisted on this origin, so the second pass lands straight
// on the confirm step.
//
// It promises one button, not zero. The confirm click is deliberate
// (see the module header) and this copy has to match it — telling the
// user "nothing else will be asked" and then asking for something is
// how an instruction stops being trusted.
function MagicLinkNote() {
  return (
    <div
      data-testid="extension-magic-link-note"
      className="rounded border border-[color:var(--kd-border-soft)] bg-white p-4 text-sm leading-relaxed text-[color:var(--kd-fg-2)]"
    >
      <strong className="font-semibold text-[color:var(--kd-fg-1)]">Using a sign-in link?</strong>{' '}
      The email opens in a normal browser tab, not this window — that&rsquo;s expected. Click the
      link there, then come back to Kindoo and press <strong>Sign in</strong> in the extension
      again. You won&rsquo;t have to sign in twice — there will be one button left to press.
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

/** Cap on the echoed `redirect_uri` — it is attacker-controllable length. */
const MAX_ECHOED_REDIRECT_CHARS = 120;

// Terminal state for a `redirect_uri` that isn't an extension callback
// origin. No affordance leads anywhere — offering a "continue anyway"
// would defeat the check.
//
// The copy says retrying won't help, and shows the offending value.
// Both exist because of how this failure looks from the extension side:
// refusing to redirect gives `launchWebAuthFlow` nothing, which is
// byte-identical to the user closing the window, so the panel can only
// report it as a cancellation and suggest a retry that can never work.
// This card is the one surface that knows better, and the person
// reading it is looking straight at it.
//
// Echoing the value is safe — it renders as text, never as an href —
// and it is what turns "sign-in keeps cancelling" into a diagnosis
// during the operator's smoke test.
//
// "configuration error" is load-bearing wording, not a phrasing
// choice: the extension panel's own copy for this path reads "unless
// that window showed a configuration error, in which case retrying
// won't help." It points back here by that phrase, so the two surfaces
// have to use the same one. Pinned by a test.
function InvalidRedirectCard({ redirectUri }: { redirectUri: string }) {
  const shown =
    redirectUri.length > MAX_ECHOED_REDIRECT_CHARS
      ? `${redirectUri.slice(0, MAX_ECHOED_REDIRECT_CHARS)}…`
      : redirectUri;
  // Distinguish "this extension isn't trusted" from "this build trusts
  // no extension at all". The second is a build-config fault, and it is
  // reachable only on the dev server — `vite build --mode staging`
  // fails on it outright. Without naming it, a developer whose unpacked
  // id simply isn't listed reads a card that implies their extension is
  // at fault and goes looking in the wrong place.
  const noneConfigured = extensionAllowlistIsEmpty();
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
        anything in from here. Trying again will land in the same place &mdash; this is a
        configuration error, not a hiccup.
      </p>
      {/* No trailing punctuation after the value — a period would
          render detached from it once the code block wraps. */}
      {shown ? (
        <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
          The address it asked us to return to:{' '}
          <code
            data-testid="extension-auth-error-redirect"
            className="break-all font-mono text-[0.8rem] text-[color:var(--kd-fg-1)]"
          >
            {shown}
          </code>
        </p>
      ) : (
        <p
          data-testid="extension-auth-error-redirect"
          className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]"
        >
          It asked us to return to no address at all.
        </p>
      )}
      {noneConfigured ? (
        <p
          data-testid="extension-auth-error-unconfigured"
          className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]"
        >
          This build of the site has no extension IDs configured, so it will refuse every extension.
          Set <code className="font-mono text-[0.8rem]">VITE_EXTENSION_IDS</code> for this build
          &mdash;{' '}
          <code className="font-mono text-[0.8rem]">pnpm --filter @kindoo/extension ext-id</code>{' '}
          prints the ID to use.
        </p>
      ) : (
        <p className="m-0 text-sm leading-relaxed text-[color:var(--kd-fg-2)]">
          Close this window. If you installed the extension by hand, reinstall{' '}
          <a
            href={CHROME_WEB_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[color:var(--kd-primary)] hover:underline"
          >
            Stake Building Access &mdash; Kindoo Helper
          </a>{' '}
          from the Chrome Web Store; otherwise send this address to your stake&rsquo;s
          administrator.
        </p>
      )}
    </div>
  );
}
