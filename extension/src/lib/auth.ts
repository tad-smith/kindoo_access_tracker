// chrome.identity → Firebase Auth bridge.
//
// Runs in the service worker context. Content scripts cannot call
// chrome.identity; they go through the message protocol in
// `messaging.ts` and let the SW perform the exchange here.
//
// Two sign-in paths land on the same Firebase session. They are
// alternatives, not fallbacks — a manager picks one in the panel.
//
// Google (`signIn`):
//   1. chrome.identity.getAuthToken({ interactive: true }) — Chrome
//      shows the Google account picker / consent screen and returns a
//      Google OAuth access token. The OAuth client id and scopes
//      come from the `oauth2` block in `manifest.config.ts`.
//   2. GoogleAuthProvider.credential(null, accessToken) — wrap the
//      access token in a Firebase credential.
//   3. signInWithCredential(auth(), credential) — exchange for a
//      Firebase ID token; subsequent callable invocations carry it.
//
// Web handoff (`signInViaWeb`):
//   1. chrome.identity.launchWebAuthFlow opens the SPA's
//      `/auth/extension` route, which offers every provider the SPA
//      supports (magic link included) — the only path open to a
//      manager with no Google account at all.
//   2. The SPA redirects back to `chrome.identity.getRedirectURL()`
//      with `#token=<Firebase custom token>`.
//   3. signInWithCustomToken exchanges it here.
//
//   The handoff carries a CUSTOM token rather than the SPA's own ID
//   token because an ID token expires in an hour and only the context
//   that owns the refresh token can renew it. The SPA's session lives
//   in a browser tab we do not control and cannot re-open silently, so
//   a relayed ID token would strand the extension one hour later.
//   `signInWithCustomToken` mints the extension its OWN refresh token,
//   which is what makes the session survive SW suspends and restarts.
//
// MV3 service workers suspend after idle; on revive they may need to
// restore Firebase Auth state. The Firebase Auth SDK persists state
// via `indexedDB` by default in browser contexts and re-hydrates on
// `getAuth()`; the SW just needs to wait for the first
// `onAuthStateChanged` to fire before answering `auth.getState`.

import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithCustomToken,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth/web-extension';
import { auth } from './firebase';
import { STORAGE_KEYS } from './messaging';
// Note: in production this module runs in the service worker context.
// Tests mock chrome.storage and firebase/auth at the module boundary.

/** Per-stake claim block written by the backend's sync triggers. Mirrors
 * `packages/shared/src/types/auth.ts` `StakeClaims`. */
interface StakeClaimBlock {
  manager?: boolean;
  stake?: boolean;
  wards?: string[];
}

/**
 * Pull the `managerStakes` list from the signed-in user's Firebase ID
 * token. Walks `claims.stakes[*]` and returns each stake id whose block
 * has `manager === true`. An empty return means the claims were read
 * successfully and the user holds no manager role anywhere — distinct
 * from a token-refresh failure, which throws so callers can surface a
 * "wire error" recovery state instead of mis-routing the user to
 * NotAuthorized or no-candidates.
 */
export async function readManagerStakes(user: User): Promise<string[]> {
  const result = await user.getIdTokenResult();
  const claims = result.claims as { stakes?: Record<string, StakeClaimBlock> };
  const map = claims.stakes;
  if (!map || typeof map !== 'object') return [];
  const out: string[] = [];
  for (const [stakeId, block] of Object.entries(map)) {
    if (block && typeof block === 'object' && block.manager === true) {
      out.push(stakeId);
    }
  }
  return out;
}

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

/** The slim principal snapshot both sign-in paths persist. One shape,
 * one place, so the two paths cannot drift apart. */
function principalSnapshot(user: User) {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
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
 *
 * Also writes the access token to `chrome.storage.local` so that on
 * SW revive we can re-derive Firebase state without re-prompting.
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
    // Persist the access token + a slim principal snapshot. On SW
    // revive Firebase's own IDB-backed persistence hydrates the user;
    // the access token is here in case we ever need to refresh or
    // re-exchange offline.
    await chrome.storage.local.set({
      [STORAGE_KEYS.googleAccessToken]: accessToken,
      [STORAGE_KEYS.principalSnapshot]: principalSnapshot(result.user),
    });
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
 * Build the SPA handoff URL. `chrome.identity.getRedirectURL()`
 * returns `https://<extension-id>.chromiumapp.org/`, which Chrome
 * intercepts instead of navigating to — that interception is what
 * hands the fragment back to us.
 *
 * The redirect URI is logged because a rejected one is otherwise
 * invisible from here. The SPA validates it against an anchored
 * `chromiumapp.org` pattern and renders a terminal error rather than
 * redirecting when it fails — which reaches us as a flow that ended
 * with no redirect URL, indistinguishable from the manager closing the
 * window, and so surfaces as "Sign-in cancelled. Click again to retry."
 * That is a retry-forever dead end for a config fault, and Chrome gives
 * us nothing to tell the two apart. One line in the SW console is what
 * makes the actual value checkable during a smoke test.
 */
function buildWebAuthUrl(): string {
  // A trailing slash in .env would produce `//auth/extension`, which
  // the SPA router does not match.
  const base = (import.meta.env.VITE_WEB_BASE_URL ?? '').replace(/\/+$/, '');
  // Fail loudly on an unconfigured build. Left empty, the URL below is
  // relative, Chrome refuses it via `lastError`, and `launchWebAuthFlow`
  // maps every `lastError` to `consent_dismissed` — so a missing env var
  // would present as "Sign-in cancelled. Click again to retry." forever,
  // on a button that can never work. The var is gitignored and
  // operator-set, so CI cannot catch this and the first deploy in a new
  // env is exactly where it lands.
  if (!base) {
    throw new AuthError('sign_in_failed', 'VITE_WEB_BASE_URL is not configured for this build');
  }
  const redirectUri = chrome.identity.getRedirectURL();
  console.info(`[sba-ext] web sign-in: redirect_uri is ${redirectUri}`);
  return `${base}/auth/extension?redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/**
 * Open the SPA auth window and resolve with the URL Chrome intercepted.
 *
 * THIS IS A FUNNEL. Every way the flow can end without a redirect
 * arrives here as one bare `chrome.runtime.lastError` carrying nothing
 * to branch on, and leaves as the single code `consent_dismissed`. The
 * set has grown four times already: the manager closing the window, a
 * `redirect_uri` the SPA refused, an unconfigured `VITE_WEB_BASE_URL`
 * (now caught earlier, in `buildWebAuthUrl`), and the magic-link first
 * pass — which is the feature's PRIMARY journey and completely normal.
 *
 * So each new upstream failure silently inherits whatever
 * `SignedOutPanel`'s copy for this code happens to assert. Three of the
 * four were shipped bugs of exactly that shape. Before adding a fifth
 * cause, either catch it before it reaches this callback (preferred —
 * that is what `buildWebAuthUrl` now does) or re-read `dismissedCopy`
 * and confirm the wording is still true for every case in the set.
 * Wording that names a cause is the thing that breaks.
 */
function launchWebAuthFlow(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      // Read lastError inside the callback — it is the signal channel
      // and reading it clears Chrome's "unchecked lastError" warning.
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new AuthError('consent_dismissed', err.message ?? 'sign-in window closed'));
        return;
      }
      if (!redirectUrl) {
        reject(new AuthError('no_token', 'sign-in flow returned no redirect URL'));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

/**
 * Read `#token` / `#error` off the intercepted redirect. The contract
 * puts both on the FRAGMENT, never the query string, so the custom
 * token stays out of server logs and `Referer` headers.
 */
function parseWebAuthFragment(redirectUrl: string): { token: string | null; error: string | null } {
  const hashIndex = redirectUrl.indexOf('#');
  const params = new URLSearchParams(hashIndex >= 0 ? redirectUrl.slice(hashIndex + 1) : '');
  return { token: params.get('token'), error: params.get('error') };
}

/**
 * Sign in by handing off to the SPA's `/auth/extension` route, which
 * offers every provider the SPA supports — including the email magic
 * link, the only path open to a manager with no Google account.
 * Returns the Firebase `User`.
 *
 * Throws `AuthError('consent_dismissed', …)` when the manager closes
 * the auth window, so the panel surfaces the same quiet "Try again"
 * copy the Google path uses. Any `#error=<code>` the SPA redirects
 * with is a hard failure — including codes this build predates, which
 * must not fall through to "success with no token".
 *
 * Writes the principal snapshot but NOT `googleAccessToken`: there is
 * no Google token on this path.
 */
export async function signInViaWeb(): Promise<User> {
  const redirectUrl = await launchWebAuthFlow(buildWebAuthUrl());
  const { token, error } = parseWebAuthFragment(redirectUrl);
  if (error) {
    throw new AuthError('sign_in_failed', `web sign-in failed (${error})`);
  }
  if (!token) {
    throw new AuthError('no_token', 'web sign-in returned no token');
  }

  try {
    const result = await signInWithCustomToken(auth(), token);
    await chrome.storage.local.set({
      [STORAGE_KEYS.principalSnapshot]: principalSnapshot(result.user),
    });
    return result.user;
  } catch (err) {
    throw new AuthError('sign_in_failed', 'firebase signInWithCustomToken rejected', {
      cause: err,
    });
  }
}

/**
 * Clear Firebase Auth state AND revoke the cached Google access token
 * so the next `signIn()` re-prompts the user.
 *
 * Best-effort on both legs — the operator-facing surface is "I am
 * signed out," and we should reach that state even if one leg fails.
 * A `signInViaWeb` session has no Google token to revoke (and the
 * manager may have no Google account at all), so the probe below must
 * resolve `undefined` and fall through rather than block the Firebase
 * sign-out. A manager who cannot sign out is worse off than one who
 * cannot sign in.
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
    await chrome.storage.local.remove([
      STORAGE_KEYS.googleAccessToken,
      STORAGE_KEYS.principalSnapshot,
      STORAGE_KEYS.eidStakeChoice,
    ]);
  } catch {
    // chrome.storage.local errors are non-fatal for sign-out.
  }

  try {
    await firebaseSignOut(auth());
  } catch (err) {
    throw new AuthError('sign_out_failed', 'firebase signOut rejected', { cause: err });
  }
}

/**
 * Non-hook snapshot accessor — returns the current user synchronously
 * from the Firebase SDK. `null` when signed out OR when the SDK has
 * not yet hydrated.
 */
export function currentUser(): User | null {
  return auth().currentUser;
}

/**
 * Resolve once the Firebase Auth SDK has hydrated its persisted
 * state. Useful in the service worker on revive — we need to wait
 * for the first onAuthStateChanged before answering `auth.getState`,
 * otherwise the panel sees a spurious `'signed-out'` blip.
 */
export function waitForAuthHydrated(): Promise<User | null> {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth(), (user) => {
      unsub();
      resolve(user);
    });
  });
}

/**
 * Subscribe to Firebase Auth state changes. The service worker uses
 * this to push `auth.stateChanged` to every open content script.
 */
export function subscribeAuthState(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth(), cb);
}
