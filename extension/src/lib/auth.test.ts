// Unit tests for the chrome.identity → Firebase Auth bridge. Mocks
// `firebase/auth/web-extension` (the SW-safe entry) and the
// `chrome.identity` surface; verifies the happy path
// (token exchange → signInWithCredential) and the consent-dismissed
// error arm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithCredentialMock = vi.fn();
const signInWithCustomTokenMock = vi.fn();
const firebaseSignOutMock = vi.fn();
const onAuthStateChangedMock = vi.fn();
const credentialMock = vi.fn((_idToken: unknown, accessToken: string) => ({
  __credential: accessToken,
}));

vi.mock('firebase/auth/web-extension', () => ({
  GoogleAuthProvider: { credential: credentialMock },
  onAuthStateChanged: onAuthStateChangedMock,
  signInWithCredential: signInWithCredentialMock,
  signInWithCustomToken: signInWithCustomTokenMock,
  signOut: firebaseSignOutMock,
}));

vi.mock('./firebase', () => ({
  auth: () => ({ __tag: 'mock-auth', currentUser: null }),
}));

type GetAuthTokenCallback = (token: string | { token: string } | undefined) => void;

interface ChromeStub {
  identity: {
    getAuthToken: ReturnType<typeof vi.fn>;
    removeCachedAuthToken: ReturnType<typeof vi.fn>;
    launchWebAuthFlow: ReturnType<typeof vi.fn>;
    getRedirectURL: ReturnType<typeof vi.fn>;
  };
  runtime: {
    lastError: { message: string } | undefined;
  };
  storage: {
    local: {
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
}

function chromeStub(): ChromeStub {
  return globalThis.chrome as unknown as ChromeStub;
}

describe('auth.signIn', () => {
  beforeEach(() => {
    chromeStub().runtime.lastError = undefined;
    chromeStub().identity.getAuthToken.mockReset();
    chromeStub().identity.removeCachedAuthToken.mockReset();
    signInWithCredentialMock.mockReset();
    credentialMock.mockClear();
  });
  afterEach(() => {
    chromeStub().runtime.lastError = undefined;
  });

  it('exchanges the Google access token for a Firebase user (happy path)', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        cb('google-access-token');
      },
    );
    const user = { uid: 'u1', email: 'mgr@example.com' };
    signInWithCredentialMock.mockResolvedValue({ user });

    const { signIn } = await import('./auth');
    const result = await signIn();

    expect(chromeStub().identity.getAuthToken).toHaveBeenCalledWith(
      { interactive: true },
      expect.any(Function),
    );
    expect(credentialMock).toHaveBeenCalledWith(null, 'google-access-token');
    expect(signInWithCredentialMock).toHaveBeenCalledWith(
      { __tag: 'mock-auth', currentUser: null },
      { __credential: 'google-access-token' },
    );
    expect(result).toBe(user);
  });

  it('accepts the structured Chrome 105+ `{ token }` shape', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        cb({ token: 'structured-token' });
      },
    );
    signInWithCredentialMock.mockResolvedValue({ user: { uid: 'u2', email: 'm2@example.com' } });

    const { signIn } = await import('./auth');
    await signIn();

    expect(credentialMock).toHaveBeenCalledWith(null, 'structured-token');
  });

  it('throws AuthError(consent_dismissed) when the user dismisses consent', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        chromeStub().runtime.lastError = { message: 'The user did not approve access.' };
        cb(undefined);
      },
    );

    const { signIn, AuthError } = await import('./auth');
    await expect(signIn()).rejects.toMatchObject({ code: 'consent_dismissed' });
    await expect(signIn()).rejects.toBeInstanceOf(AuthError);
    expect(signInWithCredentialMock).not.toHaveBeenCalled();
  });

  it('throws AuthError(no_token) when chrome.identity reports a non-dismissal failure', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        chromeStub().runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
        cb(undefined);
      },
    );

    const { signIn } = await import('./auth');
    await expect(signIn()).rejects.toMatchObject({ code: 'no_token' });
  });

  it('throws AuthError(sign_in_failed) and revokes the cached token when Firebase rejects', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        cb('stale-token');
      },
    );
    chromeStub().identity.removeCachedAuthToken.mockImplementation(
      (_opts: unknown, cb: () => void) => cb(),
    );
    signInWithCredentialMock.mockRejectedValue(new Error('bad credential'));

    const { signIn } = await import('./auth');
    await expect(signIn()).rejects.toMatchObject({ code: 'sign_in_failed' });
    expect(chromeStub().identity.removeCachedAuthToken).toHaveBeenCalledWith(
      { token: 'stale-token' },
      expect.any(Function),
    );
  });
});

describe('auth.signInViaWeb', () => {
  type LaunchCallback = (redirectUrl: string | undefined) => void;

  beforeEach(() => {
    vi.stubEnv('VITE_WEB_BASE_URL', 'https://sba.example.org');
    chromeStub().runtime.lastError = undefined;
    chromeStub().identity.launchWebAuthFlow.mockReset();
    chromeStub().identity.removeCachedAuthToken.mockReset();
    chromeStub().storage.local.set.mockReset();
    chromeStub().storage.local.set.mockResolvedValue(undefined);
    signInWithCustomTokenMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    chromeStub().runtime.lastError = undefined;
  });

  function resolveWith(redirectUrl: string | undefined) {
    chromeStub().identity.launchWebAuthFlow.mockImplementation(
      (_opts: unknown, cb: LaunchCallback) => cb(redirectUrl),
    );
  }

  it('exchanges the fragment custom token for a Firebase user (happy path)', async () => {
    resolveWith('https://sba-ext-test.chromiumapp.org/#token=custom-token-abc');
    const user = { uid: 'u9', email: 'mgr@example.org', displayName: 'Mgr' };
    signInWithCustomTokenMock.mockResolvedValue({ user });

    const { signInViaWeb } = await import('./auth');
    const result = await signInViaWeb();

    expect(chromeStub().identity.launchWebAuthFlow).toHaveBeenCalledWith(
      {
        url:
          'https://sba.example.org/auth/extension?redirect_uri=' +
          encodeURIComponent('https://sba-ext-test.chromiumapp.org/'),
        interactive: true,
      },
      expect.any(Function),
    );
    expect(signInWithCustomTokenMock).toHaveBeenCalledWith(
      { __tag: 'mock-auth', currentUser: null },
      'custom-token-abc',
    );
    expect(result).toBe(user);
  });

  it('persists the principal snapshot but never a Google access token', async () => {
    resolveWith('https://sba-ext-test.chromiumapp.org/#token=t');
    signInWithCustomTokenMock.mockResolvedValue({
      user: { uid: 'u9', email: 'mgr@example.org', displayName: 'Mgr' },
    });

    const { signInViaWeb } = await import('./auth');
    await signInViaWeb();

    const written = chromeStub().storage.local.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written['sba.principalSnapshot']).toEqual({
      uid: 'u9',
      email: 'mgr@example.org',
      displayName: 'Mgr',
    });
    expect(written).not.toHaveProperty('sba.googleAccessToken');
  });

  it('strips a trailing slash off VITE_WEB_BASE_URL so the SPA route matches', async () => {
    vi.stubEnv('VITE_WEB_BASE_URL', 'https://sba.example.org/');
    resolveWith('https://sba-ext-test.chromiumapp.org/#token=t');
    signInWithCustomTokenMock.mockResolvedValue({
      user: { uid: 'u9', email: null, displayName: null },
    });

    const { signInViaWeb } = await import('./auth');
    await signInViaWeb();

    const opts = chromeStub().identity.launchWebAuthFlow.mock.calls[0]?.[0] as { url: string };
    expect(opts.url).toContain('https://sba.example.org/auth/extension?');
  });

  it('fails loudly when VITE_WEB_BASE_URL is unset, instead of looking cancelled', async () => {
    // An unconfigured build would otherwise send a relative URL, which
    // Chrome refuses via lastError — and every lastError maps to
    // consent_dismissed, so the manager would see "Sign-in cancelled.
    // Click again to retry." forever on a button that cannot work.
    vi.stubEnv('VITE_WEB_BASE_URL', '');

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({
      code: 'sign_in_failed',
      message: expect.stringContaining('VITE_WEB_BASE_URL'),
    });
    // Never opens a window it knows cannot succeed.
    expect(chromeStub().identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  // Strings below are Chromium's own, verbatim from
  // `identity_constants.cc`. Only the approval-shaped ones may reach
  // `consent_dismissed`; everything else is a real failure.
  it('treats a page that never loaded as a failure, not a dismissal', async () => {
    // kPageLoadFailure. Reached by a typo'd VITE_WEB_BASE_URL, an SPA
    // outage, or an offline manager. The dismissal copy would tell them
    // to go open a sign-in link from a window that never rendered.
    chromeStub().identity.launchWebAuthFlow.mockImplementation(
      (_opts: unknown, cb: LaunchCallback) => {
        chromeStub().runtime.lastError = { message: 'Authorization page could not be loaded.' };
        cb(undefined);
      },
    );

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'sign_in_failed' });
  });

  it('treats an unrecognised message as a failure — the safe default', async () => {
    // Chrome's strings vary across builds and the failure set cannot be
    // enumerated, so anything not approval-shaped must be a real error.
    chromeStub().identity.launchWebAuthFlow.mockImplementation(
      (_opts: unknown, cb: LaunchCallback) => {
        chromeStub().runtime.lastError = { message: 'Some future Chrome wording.' };
        cb(undefined);
      },
    );

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'sign_in_failed' });
  });

  it('keeps the magic-link first pass on consent_dismissed', async () => {
    // THE PRIMARY JOURNEY. Closing the launchWebAuthFlow window reports
    // kUserRejected — the same string a declined consent dialog gives —
    // so the friendly "open it from your email" copy still applies. If
    // this ever stops matching, the primary journey starts rendering as
    // a red failure.
    chromeStub().identity.launchWebAuthFlow.mockImplementation(
      (_opts: unknown, cb: LaunchCallback) => {
        chromeStub().runtime.lastError = { message: 'The user did not approve access.' };
        cb(undefined);
      },
    );

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'consent_dismissed' });
  });

  it('throws AuthError(consent_dismissed) when the manager closes the auth window', async () => {
    chromeStub().identity.launchWebAuthFlow.mockImplementation(
      (_opts: unknown, cb: LaunchCallback) => {
        // The SPA never redirects on a cancelled sign-in; Chrome
        // reports the closed window here instead.
        chromeStub().runtime.lastError = { message: 'The user did not approve access.' };
        cb(undefined);
      },
    );

    const { signInViaWeb, AuthError } = await import('./auth');
    await expect(signInViaWeb()).rejects.toBeInstanceOf(AuthError);
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'consent_dismissed' });
    expect(signInWithCustomTokenMock).not.toHaveBeenCalled();
  });

  it('throws AuthError(sign_in_failed) on the SPA-reported #error=mint_failed', async () => {
    resolveWith('https://sba-ext-test.chromiumapp.org/#error=mint_failed');

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'sign_in_failed' });
    expect(signInWithCustomTokenMock).not.toHaveBeenCalled();
  });

  it('treats an unrecognised #error code as a hard failure, not a silent success', async () => {
    resolveWith('https://sba-ext-test.chromiumapp.org/#error=some_future_code');

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'sign_in_failed' });
    expect(signInWithCustomTokenMock).not.toHaveBeenCalled();
  });

  it('throws AuthError(no_token) when the fragment carries neither token nor error', async () => {
    resolveWith('https://sba-ext-test.chromiumapp.org/');

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'no_token' });
    expect(signInWithCustomTokenMock).not.toHaveBeenCalled();
  });

  it('wraps a rejected custom-token exchange without touching the Google token cache', async () => {
    resolveWith('https://sba-ext-test.chromiumapp.org/#token=expired');
    signInWithCustomTokenMock.mockRejectedValue(new Error('auth/invalid-custom-token'));

    const { signInViaWeb } = await import('./auth');
    await expect(signInViaWeb()).rejects.toMatchObject({ code: 'sign_in_failed' });
    // There is no Google token on this path; revoking one would be a
    // no-op at best and a cross-path side effect at worst.
    expect(chromeStub().identity.removeCachedAuthToken).not.toHaveBeenCalled();
  });
});

describe('auth.signOut', () => {
  beforeEach(() => {
    chromeStub().runtime.lastError = undefined;
    chromeStub().identity.getAuthToken.mockReset();
    chromeStub().identity.removeCachedAuthToken.mockReset();
    firebaseSignOutMock.mockReset();
  });

  it('revokes the cached Google token and signs out of Firebase', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        cb('cached-token');
      },
    );
    chromeStub().identity.removeCachedAuthToken.mockImplementation(
      (_opts: unknown, cb: () => void) => cb(),
    );
    firebaseSignOutMock.mockResolvedValue(undefined);

    const { signOut } = await import('./auth');
    await signOut();

    expect(chromeStub().identity.removeCachedAuthToken).toHaveBeenCalledWith(
      { token: 'cached-token' },
      expect.any(Function),
    );
    expect(firebaseSignOutMock).toHaveBeenCalled();
  });

  it('still signs out of Firebase if no cached token exists', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        chromeStub().runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
        cb(undefined);
      },
    );
    firebaseSignOutMock.mockResolvedValue(undefined);

    const { signOut } = await import('./auth');
    await signOut();

    expect(chromeStub().identity.removeCachedAuthToken).not.toHaveBeenCalled();
    expect(firebaseSignOutMock).toHaveBeenCalled();
  });

  it('signs out a web-flow manager who has no Google account at all', async () => {
    // `signInViaWeb` never mints a Google token, and the manager may
    // hold no Google identity to mint one from — so the cached-token
    // probe must resolve undefined and fall through to firebaseSignOut
    // rather than stranding them signed in.
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => {
        chromeStub().runtime.lastError = { message: 'The user is not signed in.' };
        cb(undefined);
      },
    );
    chromeStub().storage.local.remove.mockReset();
    chromeStub().storage.local.remove.mockResolvedValue(undefined);
    firebaseSignOutMock.mockResolvedValue(undefined);

    const { signOut } = await import('./auth');
    await signOut();

    expect(chromeStub().identity.removeCachedAuthToken).not.toHaveBeenCalled();
    expect(chromeStub().storage.local.remove).toHaveBeenCalledWith(
      expect.arrayContaining(['sba.principalSnapshot']),
    );
    expect(firebaseSignOutMock).toHaveBeenCalled();
  });

  it('wraps Firebase sign-out failures as AuthError(sign_out_failed)', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => cb(undefined),
    );
    firebaseSignOutMock.mockRejectedValue(new Error('network'));

    const { signOut } = await import('./auth');
    await expect(signOut()).rejects.toMatchObject({ code: 'sign_out_failed' });
  });
});

describe('readManagerStakes', () => {
  it('returns every stake id with manager === true', async () => {
    const user = {
      getIdTokenResult: vi.fn().mockResolvedValue({
        claims: {
          stakes: {
            csnorth: { manager: true, stake: false, wards: [] },
            'east-co': { manager: true, stake: false, wards: [] },
            'south-co': { manager: false, stake: true, wards: [] },
          },
        },
      }),
    };
    const { readManagerStakes } = await import('./auth');
    const out = await readManagerStakes(user as never);
    expect(out.sort()).toEqual(['csnorth', 'east-co']);
  });

  it('returns an empty array when the user has no stake claims', async () => {
    const user = {
      getIdTokenResult: vi.fn().mockResolvedValue({ claims: {} }),
    };
    const { readManagerStakes } = await import('./auth');
    expect(await readManagerStakes(user as never)).toEqual([]);
  });

  it('propagates the error when getIdTokenResult throws (callers route to wire-error state)', async () => {
    // Risk 2 fix: swallowing to [] would conflate token-refresh
    // failures with "user has no manager roles," routing transient
    // wire failures to NotAuthorized or no-candidates. The resolver
    // now propagates so App.tsx can surface the distinct
    // "Couldn't reach SBA" recovery copy.
    const user = {
      getIdTokenResult: vi.fn().mockRejectedValue(new Error('network')),
    };
    const { readManagerStakes } = await import('./auth');
    await expect(readManagerStakes(user as never)).rejects.toThrow('network');
  });

  it('ignores non-manager entries (stake-only, bishopric-only)', async () => {
    const user = {
      getIdTokenResult: vi.fn().mockResolvedValue({
        claims: {
          stakes: {
            csnorth: { manager: false, stake: true, wards: [] },
            'east-co': { manager: false, stake: false, wards: ['CO'] },
          },
        },
      }),
    };
    const { readManagerStakes } = await import('./auth');
    expect(await readManagerStakes(user as never)).toEqual([]);
  });
});
