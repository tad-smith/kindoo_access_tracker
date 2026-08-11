// Tests for /auth/extension — the sign-in handoff the Chrome extension
// opens inside `chrome.identity.launchWebAuthFlow` (spec §4.1).
//
// The load-bearing assertion is the negative one: a `redirect_uri` that
// isn't an extension callback origin must never produce a redirect of
// any kind, because that redirect is what would hand a session token to
// an arbitrary origin.

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Principal } from '../../lib/principal';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const VALID_REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/`;

const mintMock = vi.fn<() => Promise<string>>();
const authReadyMock = vi.fn<() => boolean>();

vi.mock('../../features/auth/hooks', () => ({
  useAuthReady: () => authReadyMock(),
  useMintExtensionToken: () => ({ mutateAsync: mintMock }),
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

import { REDIRECT_URI_PATTERN, Route } from './extension';

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

describe('REDIRECT_URI_PATTERN', () => {
  it('accepts an extension callback origin with or without a trailing slash', () => {
    expect(REDIRECT_URI_PATTERN.test(`https://${EXTENSION_ID}.chromiumapp.org`)).toBe(true);
    expect(REDIRECT_URI_PATTERN.test(`https://${EXTENSION_ID}.chromiumapp.org/`)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['http rather than https', `http://${EXTENSION_ID}.chromiumapp.org/`],
    ['an unrelated host', 'https://evil.example.com/'],
    [
      'the callback host as a prefix of another domain',
      `https://${EXTENSION_ID}.chromiumapp.org.evil.com/`,
    ],
    ['a path beyond the origin', `https://${EXTENSION_ID}.chromiumapp.org/steal`],
    ['a query string', `https://${EXTENSION_ID}.chromiumapp.org/?next=evil`],
    ['an id one character short', `https://${EXTENSION_ID.slice(1)}.chromiumapp.org/`],
    ['an id one character long', `https://${EXTENSION_ID}a.chromiumapp.org/`],
    ['an id outside the a-p alphabet', `https://${EXTENSION_ID.slice(1)}z.chromiumapp.org/`],
    ['an uppercase id', `https://${EXTENSION_ID.toUpperCase()}.chromiumapp.org/`],
    ['a subdomain under the callback host', `https://x.${EXTENSION_ID}.chromiumapp.org/`],
    // `$` anchors at end-of-input in JS (unlike Python, where it also
    // matches before a trailing newline) — pinned so a future rewrite
    // that adds the `m` flag fails here rather than in production.
    ['a trailing newline', `https://${EXTENSION_ID}.chromiumapp.org/\n`],
    [
      'a newline-smuggled second line',
      `https://${EXTENSION_ID}.chromiumapp.org/\nhttps://evil.com`,
    ],
  ])('rejects %s', (_label, uri) => {
    expect(REDIRECT_URI_PATTERN.test(uri)).toBe(false);
  });
});

describe('/auth/extension — redirect_uri validation', () => {
  it('renders a terminal error and never redirects when redirect_uri is not an extension origin', async () => {
    mockedPrincipal.current = signedInPrincipal;
    mintMock.mockResolvedValue('custom-token');

    renderRoute('https://evil.example.com/');

    expect(await screen.findByTestId('extension-auth-error')).toBeInTheDocument();
    // The signed-in branch would otherwise have minted immediately.
    expect(mintMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
    // No sign-in affordance either — the state is terminal.
    expect(screen.queryByRole('button', { name: /Continue with Google/i })).toBeNull();
  });

  it('renders the terminal error when redirect_uri is absent', async () => {
    renderRoute('');

    expect(await screen.findByTestId('extension-auth-error')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
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
  });

  it('mints a custom token and hands it back on the redirect fragment', async () => {
    mintMock.mockResolvedValue('header.payload.signature');

    renderRoute(VALID_REDIRECT);

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(`${VALID_REDIRECT}#token=header.payload.signature`),
    );
    expect(mintMock).toHaveBeenCalledTimes(1);
  });

  it('percent-encodes the token so fragment metacharacters survive the handoff', async () => {
    mintMock.mockResolvedValue('a+b/c=d&e#f');

    renderRoute(VALID_REDIRECT);

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(
        `${VALID_REDIRECT}#token=${encodeURIComponent('a+b/c=d&e#f')}`,
      ),
    );
  });

  it('redirects with mint_failed and no token when the callable rejects', async () => {
    mintMock.mockRejectedValue(new Error('functions/internal'));

    renderRoute(VALID_REDIRECT);

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith(`${VALID_REDIRECT}#error=mint_failed`),
    );
    expect(replaceMock.mock.calls[0]?.[0]).not.toContain('token=');
  });

  it('accepts a redirect_uri with no trailing slash', async () => {
    const bare = `https://${EXTENSION_ID}.chromiumapp.org`;
    mintMock.mockResolvedValue('tok');

    renderRoute(bare);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith(`${bare}#token=tok`));
  });

  it('mints once under a StrictMode double-mount', async () => {
    mintMock.mockResolvedValue('tok');

    renderRoute(VALID_REDIRECT, { strict: true });

    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledTimes(1);
  });
});
