// chrome.identity → Firebase Auth bridge for the extension.
//
// Flow:
//   1. chrome.identity.getAuthToken({ interactive: true }) — Chrome shows
//      the Google account picker / consent screen and returns a Google
//      OAuth access token. The OAuth client id and scopes come from the
//      `oauth2` block in `manifest.config.ts`.
//   2. GoogleAuthProvider.credential(null, accessToken) — wrap the
//      access token in a Firebase credential.
//   3. signInWithCredential(auth(), credential) — exchange for a
//      Firebase ID token; subsequent callable invocations carry it.
//
// The Google access token is cached in Chrome's identity-token store.
// `signOut()` clears Firebase state AND revokes the cached Google
// token so the next sign-in re-prompts cleanly (otherwise Chrome
// silently re-uses the cached token and a user who picked the wrong
// account is stuck).

import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { useEffect, useState } from 'react';
import { auth } from './firebase';

/** Discriminated error codes the UI can switch on for friendlier copy. */
export type AuthErrorCode = 'consent_dismissed' | 'no_token' | 'sign_in_failed' | 'sign_out_failed';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Request a Google OAuth access token via the Chrome identity API.
 * Resolves with the raw access token string. Rejects with an
 * `AuthError` when the user dismisses the consent dialog or Chrome
 * otherwise refuses to mint a token.
 */
function getGoogleAccessToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      // chrome.runtime.lastError is the standard signal channel for
      // identity failures; reading it inside the callback also clears
      // Chrome's "unchecked lastError" console warning.
      const err = chrome.runtime.lastError;
      if (err) {
        const message = err.message ?? 'chrome.identity.getAuthToken failed';
        // The exact error string varies across Chrome builds, but the
        // common dismissal path includes the word "denied" or "did not
        // approve". Treat anything with "denied"/"cancel" as a
        // dismissal so the UI can render a soft retry instead of a
        // hard error.
        const lower = message.toLowerCase();
        if (
          lower.includes('did not approve') ||
          lower.includes('denied') ||
          lower.includes('cancel')
        ) {
          reject(new AuthError('consent_dismissed', message));
          return;
        }
        reject(new AuthError('no_token', message));
        return;
      }
      // Chrome 105+ resolves with a structured `{ token, grantedScopes }`
      // object; older surfaces hand back a bare string. Normalize.
      const accessToken =
        typeof token === 'string'
          ? token
          : ((token as { token?: string } | undefined)?.token ?? '');
      if (!accessToken) {
        reject(new AuthError('no_token', 'chrome.identity returned no token'));
        return;
      }
      resolve(accessToken);
    });
  });
}

/** Revoke the cached Google access token so the next sign-in re-prompts. */
function removeCachedAuthToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      // Best-effort: lastError on remove is non-actionable.
      resolve();
    });
  });
}

/**
 * Sign in via the Chrome identity API and exchange the Google access
 * token for a Firebase session. Returns the Firebase `User`.
 *
 * Throws `AuthError('consent_dismissed', …)` when the user closes the
 * consent dialog — UI can surface a quiet "Try again" instead of a
 * red banner.
 */
export async function signIn(): Promise<User> {
  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('sign_in_failed', 'failed to acquire Google access token', {
      cause: err,
    });
  }

  const credential = GoogleAuthProvider.credential(null, accessToken);
  try {
    const result = await signInWithCredential(auth(), credential);
    return result.user;
  } catch (err) {
    // If Firebase rejects the credential, the cached Google token may
    // be stale — revoke so a retry re-prompts the user.
    await removeCachedAuthToken(accessToken).catch(() => undefined);
    throw new AuthError('sign_in_failed', 'firebase signInWithCredential rejected', {
      cause: err,
    });
  }
}

/**
 * Clear Firebase Auth state AND revoke the cached Google access token
 * so the next `signIn()` re-prompts the user.
 *
 * Best-effort on both legs — the operator-facing surface is "I'm
 * signed out," and we should reach that state even if one leg fails.
 */
export async function signOut(): Promise<void> {
  let cachedToken: string | undefined;
  try {
    cachedToken = await new Promise<string | undefined>((resolve) => {
      // `interactive: false` returns the cached token (if any) without
      // showing UI. If there is no cached token, lastError fires and we
      // resolve undefined.
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        // Drain lastError so the next caller does not see a stale one.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        chrome.runtime.lastError;
        const normalized =
          typeof token === 'string' ? token : (token as { token?: string } | undefined)?.token;
        resolve(normalized ?? undefined);
      });
    });
  } catch {
    cachedToken = undefined;
  }

  if (cachedToken) {
    await removeCachedAuthToken(cachedToken).catch(() => undefined);
  }

  try {
    await firebaseSignOut(auth());
  } catch (err) {
    throw new AuthError('sign_out_failed', 'firebase signOut rejected', { cause: err });
  }
}

/** Snapshot of the current Firebase Auth state for the UI to render against. */
export type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'signed-out'; user: null }
  | { status: 'signed-in'; user: User };

/**
 * React hook: subscribes to Firebase Auth state changes and returns
 * the current snapshot. Starts in `'loading'` until the first
 * `onAuthStateChanged` fires.
 */
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });
  useEffect(() => {
    const unsub = onAuthStateChanged(auth(), (user) => {
      if (user) {
        setState({ status: 'signed-in', user });
      } else {
        setState({ status: 'signed-out', user: null });
      }
    });
    return () => unsub();
  }, []);
  return state;
}

/**
 * Non-hook snapshot accessor — returns the current user synchronously
 * from the Firebase SDK. Useful in places that cannot use a hook
 * (e.g., the service worker). `null` when signed out OR when the SDK
 * has not yet hydrated; callers that care about the distinction
 * should use `useAuthState()` instead.
 */
export function currentUser(): User | null {
  return auth().currentUser;
}
