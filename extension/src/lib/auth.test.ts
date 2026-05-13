// Unit tests for the chrome.identity → Firebase Auth bridge. Mocks
// `firebase/auth/web-extension` (the SW-safe entry) and the
// `chrome.identity` surface; verifies the happy path
// (token exchange → signInWithCredential) and the consent-dismissed
// error arm.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithCredentialMock = vi.fn();
const firebaseSignOutMock = vi.fn();
const onAuthStateChangedMock = vi.fn();
const credentialMock = vi.fn((_idToken: unknown, accessToken: string) => ({
  __credential: accessToken,
}));

vi.mock('firebase/auth/web-extension', () => ({
  GoogleAuthProvider: { credential: credentialMock },
  onAuthStateChanged: onAuthStateChangedMock,
  signInWithCredential: signInWithCredentialMock,
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
  };
  runtime: {
    lastError: { message: string } | undefined;
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

  it('wraps Firebase sign-out failures as AuthError(sign_out_failed)', async () => {
    chromeStub().identity.getAuthToken.mockImplementation(
      (_opts: unknown, cb: GetAuthTokenCallback) => cb(undefined),
    );
    firebaseSignOutMock.mockRejectedValue(new Error('network'));

    const { signOut } = await import('./auth');
    await expect(signOut()).rejects.toMatchObject({ code: 'sign_out_failed' });
  });
});
