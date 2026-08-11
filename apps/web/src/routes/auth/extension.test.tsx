// Tests for /auth/extension — the sign-in handoff the Chrome extension
// opens inside `chrome.identity.launchWebAuthFlow` (spec §4.1).
//
// Two gates guard the mint, and the negative assertions matter more
// than the positive one:
//   - An untrusted `redirect_uri` never produces a redirect of any kind
//     (allowlist coverage lives in `features/auth/extensionRedirect.test.ts`).
//   - Nothing is minted without a click, so a background
//     `launchWebAuthFlow({ interactive: false })` cannot harvest a token.

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Principal } from '../../lib/principal';
import { CHROME_EXTENSION_ID } from '../../lib/links';

// The published extension — the one identity this build trusts by
// default. Using it (rather than any shape-valid string) is what makes
// these render tests exercise the same allowlist production uses.
const VALID_REDIRECT = `https://${CHROME_EXTENSION_ID}.chromiumapp.org/`;
/** Shape-valid, belongs to some other extension in the profile. */
const UNTRUSTED_REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';

const mintMock = vi.fn<() => Promise<string>>();
const authReadyMock = vi.fn<() => boolean>();

vi.mock('../../features/auth/hooks', () => ({
  useAuthReady: () => authReadyMock(),
  useMintExtensionToken: () => ({ mutateAsync: mintMock }),
}));

const signOutMock = vi.fn<() => Promise<void>>();
vi.mock('../../features/auth/signOut', () => ({
  signOut: () => signOutMock(),
}));

// `useSignInForm` pulls the real sign-in helpers, which import the
// Firebase SDK singletons. Mock at the same boundary SignInPage's tests
// use so the provider block renders without any SDK init.
const sendMagicLinkMock = vi.fn();
const signInWithGoogleMock = vi.fn();
const clearStashedEmailMock = vi.fn();
vi.mock('../../features/auth/signIn', () => ({
  sendMagicLink: (email: string) => sendMagicLinkMock(email),
  signInWithGoogle: () => signInWithGoogleMock(),
  clearStashedEmail: () => clearStashedEmailMock(),
}));

const signedOutPrincipal: Principal = {
  isAuthenticated: false,
  firebaseAuthSignedIn: false,
  email: '',
  canonical: '',
  isPlatformSuperadmin: false,
  managerStakes: [],
  stakeMemberStakes: [],
  bishopricWards: {},
  limitedStakes: [],
  bootstrapStakes: [],
  hasAnyRole: () => false,
  wardsInStake: () => [],
};

const signedInPrincipal: Principal = {
  ...signedOutPrincipal,
  isAuthenticated: true,
  firebaseAuthSignedIn: true,
  email: 'manager@example.com',
  canonical: 'manager@example.com',
};

const mockedPrincipal = { current: signedOutPrincipal };
vi.mock('../../lib/principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

import { Route } from './extension';

const ExtensionAuthRoute = Route.options.component as () => React.ReactElement | null;

const searchSpy = vi.spyOn(Route, 'useSearch');

function renderRoute(redirectUri: string, opts: { strict?: boolean } = {}) {
  searchSpy.mockReturnValue({ redirect_uri: redirectUri } as never);
  return opts.strict
    ? render(
        <StrictMode>
          <ExtensionAuthRoute />
        </StrictMode>,
      )
    : render(<ExtensionAuthRoute />);
}

const replaceMock = vi.fn();
const ORIGINAL_LOCATION = window.location;

beforeEach(() => {
  mintMock.mockReset();
  authReadyMock.mockReset().mockReturnValue(true);
  sendMagicLinkMock.mockReset();
  signInWithGoogleMock.mockReset();
  clearStashedEmailMock.mockReset();
  signOutMock.mockReset().mockResolvedValue(undefined);
  replaceMock.mockReset();
  mockedPrincipal.current = signedOutPrincipal;
  // jsdom refuses a real navigation; swap in a stub carrying the only
  // member the route touches.
  Object.defineProperty(window, 'location', {
    configurable: true,
    enumerable: true,
    value: { href: 'https://app.example.com/auth/extension', replace: replaceMock },
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    enumerable: true,
    value: ORIGINAL_LOCATION,
    writable: true,
  });
});

describe('/auth/extension — redirect_uri validation', () => {
  it('renders a terminal error and never redirects when redirect_uri is not an extension origin', async () => {
    mockedPrincipal.current = signedInPrincipal;
    mintMock.mockResolvedValue('custom-token');

    renderRoute('https://evil.example.com/');

    expect(await screen.findByTestId('extension-auth-error')).toBeInTheDocument();
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
    // No sign-in affordance either — the state is terminal.
    expect(screen.queryByRole('button', { name: /Continue with Google/i })).toBeNull();
  });

  // A different extension in the manager's profile, whose callback
  // origin is every bit as well-formed as ours. Shape validation alone
  // would let it through, and with a signed-in manager that is a token
  // in someone else's hands.
  it('refuses a well-formed callback origin belonging to an untrusted extension', async () => {
    mockedPrincipal.current = signedInPrincipal;
    mintMock.mockResolvedValue('custom-token');

    renderRoute(UNTRUSTED_REDIRECT);

    expect(await screen.findByTestId('extension-auth-error')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-connect')).toBeNull();
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders the terminal error when redirect_uri is absent', async () => {
    renderRoute('');

    expect(await screen.findByTestId('extension-auth-error')).toBeInTheDocument();
    expect(screen.getByTestId('extension-auth-error-redirect')).toHaveTextContent(
      /no address at all/i,
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // Refusing to redirect leaves `launchWebAuthFlow` with nothing, which
  // the extension cannot tell apart from the user closing the window —
  // so its panel reports a cancellation and suggests a retry that can
  // never work. This card is the only surface that knows better.
  it('says plainly that retrying will not help', async () => {
    renderRoute('https://evil.example.com/');

    expect(await screen.findByTestId('extension-auth-error')).toHaveTextContent(
      /configuration error, not a hiccup/i,
    );
  });

  // Cross-surface linkage, not a phrasing preference. The extension
  // panel's copy for this path reads "unless that window showed a
  // configuration error, in which case retrying won't help" — it refers
  // the user back to this card by that exact phrase. Reword this and
  // the panel starts pointing at words the user never saw.
  it('uses the phrase the extension panel refers back to', async () => {
    renderRoute('https://evil.example.com/');

    expect(await screen.findByTestId('extension-auth-error')).toHaveTextContent(
      'configuration error',
    );
  });

  it('shows the offending redirect_uri so the fault is diagnosable on sight', async () => {
    renderRoute('https://evil.example.com/steal');

    expect(await screen.findByTestId('extension-auth-error-redirect')).toHaveTextContent(
      'https://evil.example.com/steal',
    );
  });

  it('truncates an over-long redirect_uri rather than letting it run off the card', async () => {
    const huge = `https://evil.example.com/${'a'.repeat(500)}`;
    renderRoute(huge);

    const echoed = await screen.findByTestId('extension-auth-error-redirect');
    expect(echoed.textContent ?? '').toHaveLength(121);
    expect(echoed.textContent ?? '').toMatch(/…$/);
  });

  // The value is attacker-controllable, so it must reach the DOM as
  // text only — never as an href, and never parsed as markup.
  it('renders the offending value as inert text, not as a link', async () => {
    renderRoute('javascript:alert(1)');

    const echoed = await screen.findByTestId('extension-auth-error-redirect');
    expect(echoed.textContent).toContain('javascript:alert(1)');
    expect(echoed.querySelector('a')).toBeNull();
    expect(echoed.tagName.toLowerCase()).toBe('code');
  });
});

describe('/auth/extension — signed out', () => {
  it('offers both sign-in providers so a manager without a Google account can proceed', async () => {
    renderRoute(VALID_REDIRECT);

    expect(
      await screen.findByRole('button', { name: /Continue with Google/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send me a sign-in link/i })).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('explains that the emailed link opens in a browser tab and to press Sign in again afterwards', async () => {
    renderRoute(VALID_REDIRECT);

    const note = await screen.findByTestId('extension-magic-link-note');
    expect(note).toHaveTextContent(/normal browser tab, not this window/i);
    expect(note).toHaveTextContent(/press Sign in in the extension again/i);
    // Guidance, not a failure — it must not be announced as an alert.
    expect(note.getAttribute('role')).toBeNull();
  });

  it('keeps the emailed-link guidance visible after the link is sent', async () => {
    sendMagicLinkMock.mockResolvedValue(undefined);
    renderRoute(VALID_REDIRECT);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email address/i), 'manager@example.com');
    await user.click(screen.getByRole('button', { name: /Send me a sign-in link/i }));

    expect(await screen.findByTestId('signin-confirmation')).toHaveTextContent(
      /come back to Kindoo and press Sign in in the extension again/i,
    );
    expect(screen.getByTestId('extension-magic-link-note')).toBeInTheDocument();
  });

  it('waits for Firebase Auth to rehydrate before showing the sign-in form', () => {
    authReadyMock.mockReturnValue(false);

    renderRoute(VALID_REDIRECT);

    expect(screen.queryByRole('button', { name: /Continue with Google/i })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/Checking your sign-in/i);
    expect(mintMock).not.toHaveBeenCalled();
  });
});

describe('/auth/extension — signed in', () => {
  beforeEach(() => {
    mockedPrincipal.current = signedInPrincipal;
    mintMock.mockResolvedValue('header.payload.signature');
  });

  async function clickConnect() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Connect the extension$/i }));
  }

  // The gate that defeats `launchWebAuthFlow({ interactive: false })`.
  // A non-interactive flow renders no UI, so it can never produce this
  // click — which means it can never reach the mint, even when the
  // manager holds a live session and the caller is allowlisted.
  it('mints nothing on mount — the handoff waits for an explicit click', async () => {
    renderRoute(VALID_REDIRECT);

    expect(await screen.findByTestId('extension-connect')).toBeInTheDocument();
    // Give any stray effect a chance to fire before asserting silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('mints nothing on mount under a StrictMode double-mount either', async () => {
    renderRoute(VALID_REDIRECT, { strict: true });

    expect(await screen.findByTestId('extension-connect')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // The browser profile decides whose session this is, so the confirm
  // has to say whose it is — otherwise a machine signed in as someone
  // else hands the extension that identity silently.
  it('names the account the extension will act as', async () => {
    renderRoute(VALID_REDIRECT);

    expect(await screen.findByTestId('extension-connect')).toHaveTextContent('manager@example.com');
  });

  it('mints a custom token and hands it back on the redirect fragment when clicked', async () => {
    renderRoute(VALID_REDIRECT);
    await clickConnect();

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(`${VALID_REDIRECT}#token=header.payload.signature`),
    );
    expect(mintMock).toHaveBeenCalledTimes(1);
  });

  it('percent-encodes the token so fragment metacharacters survive the handoff', async () => {
    mintMock.mockResolvedValue('a+b/c=d&e#f');

    renderRoute(VALID_REDIRECT);
    await clickConnect();

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        `${VALID_REDIRECT}#token=${encodeURIComponent('a+b/c=d&e#f')}`,
      ),
    );
  });

  it('redirects with mint_failed and no token when the callable rejects', async () => {
    mintMock.mockRejectedValue(new Error('functions/internal'));

    renderRoute(VALID_REDIRECT);
    await clickConnect();

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(`${VALID_REDIRECT}#error=mint_failed`),
    );
    expect(replaceMock.mock.calls[0]?.[0]).not.toContain('token=');
  });

  it('accepts a redirect_uri with no trailing slash', async () => {
    const bare = `https://${CHROME_EXTENSION_ID}.chromiumapp.org`;
    mintMock.mockResolvedValue('tok');

    renderRoute(bare);
    await clickConnect();

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(`${bare}#token=tok`));
  });

  it('disables the button while minting so a double-click cannot mint twice', async () => {
    let release: (token: string) => void = () => {};
    mintMock.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    renderRoute(VALID_REDIRECT);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /^Connect the extension$/i });
    await user.click(button);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Connecting…/i })).toBeDisabled(),
    );
    await user.click(screen.getByRole('button', { name: /Connecting…/i }));
    expect(mintMock).toHaveBeenCalledTimes(1);

    release('tok');
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(`${VALID_REDIRECT}#token=tok`));
  });

  it('signs out and returns to the providers when the wrong account is signed in', async () => {
    renderRoute(VALID_REDIRECT);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Use a different account/i }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();

    // `usePrincipal` drives the swap in production; mirror that here to
    // prove the signed-out branch is what the user lands on.
    mockedPrincipal.current = signedOutPrincipal;
    renderRoute(VALID_REDIRECT);
    expect(
      await screen.findByRole('button', { name: /Continue with Google/i }),
    ).toBeInTheDocument();
  });
});
