// Email magic link sign-in helpers (spec §4.1).
//
// The SPA's only sign-in surface is the Firebase Auth email-link
// (passwordless) flow. The user types an email; we call
// `sendSignInLinkToEmail` and stash the typed email in localStorage. The
// emailed link lands on the action-handler route under `/auth/email-link`
// (see `apps/web/src/routes/auth/email-link.tsx`), which reads the
// stashed email back and calls `signInWithEmailLink` to complete the
// round-trip. Cross-device handling lives in the action-handler route.
//
// CRITICAL — token-refresh sequencing. After `signInWithEmailLink`
// resolves, the `onAuthUserCreate` Cloud Function trigger writes
// `userIndex/{canonical}` AND seeds custom claims from any pre-existing
// `kindooManagers/access` rows. That trigger is async — it runs in
// parallel with the client's first token refresh. If our refresh lands
// at the Auth backend before the trigger calls `setCustomUserClaims`,
// the refreshed token has no role claims and the user lands on
// NotAuthorized despite having a valid access doc (B-4).
//
// Mitigation — bounded poll-and-refresh after the initial refresh.
// Probe the decoded claims for `canonical` (the field
// `seedClaimsFromRoleData` always sets when the trigger completes); if
// it's missing, sleep 500ms, force-refresh, retry. 10 iterations × 500ms
// caps the wait at 5s. If claims never arrive (trigger crashed, network
// stall, etc.), we still resolve with whatever the last token had —
// the gate downstream handles "no claims → NotAuthorized" the same way
// it always has.

import {
  isSignInWithEmailLink as fbIsSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  type ActionCodeSettings,
  type User,
} from 'firebase/auth';
import { auth } from '../../lib/firebase';

const POLL_ITERATIONS = 10;
const POLL_INTERVAL_MS = 500;

/** localStorage key for the email typed at sign-in request time. */
export const EMAIL_FOR_LINK_STORAGE_KEY = 'kindoo:auth:emailForLink';

/** Path of the action-handler route the emailed link points back to. */
export const EMAIL_LINK_ACTION_PATH = '/auth/email-link';

/**
 * Build the `actionCodeSettings` payload for `sendSignInLinkToEmail`.
 *
 * `url` is computed from `window.location.origin` so the link returns to
 * whichever host originated the request — `stakebuildingaccess.org`,
 * `kindoo.csnorth.org`, the project's default `*.firebaseapp.com` Auth
 * domain, or `localhost` during dev. Each of those hosts must be on the
 * Firebase Auth Authorized Domains list (Console → Authentication →
 * Settings → Authorized domains); missing entries surface at runtime as
 * `auth/unauthorized-continue-uri`.
 */
export function buildActionCodeSettings(): ActionCodeSettings {
  return {
    url: `${window.location.origin}${EMAIL_LINK_ACTION_PATH}`,
    handleCodeInApp: true,
  };
}

/**
 * Send a magic sign-in link to the typed email and stash that email in
 * localStorage so the action-handler route can complete the round-trip
 * without re-prompting on the same device.
 *
 * Throws (via the SDK) on:
 *   - `auth/invalid-email` — malformed address.
 *   - `auth/unauthorized-continue-uri` — origin not on Authorized Domains.
 *   - `auth/network-request-failed` — transient.
 */
export async function sendMagicLink(email: string): Promise<void> {
  const settings = buildActionCodeSettings();
  await sendSignInLinkToEmail(auth, email, settings);
  try {
    window.localStorage.setItem(EMAIL_FOR_LINK_STORAGE_KEY, email);
  } catch {
    // Quota / SecurityError from localStorage is non-fatal — the
    // user just falls through to the cross-device prompt on the
    // action-handler page.
  }
}

/** Whether `href` is a Firebase email-link sign-in URL. */
export function isSignInWithEmailLink(href: string): boolean {
  return fbIsSignInWithEmailLink(auth, href);
}

/**
 * Read (and remove) the email that was stashed at `sendMagicLink` time.
 * Returns `null` when the link was opened on a different device (or
 * after the localStorage entry was cleared / never written).
 */
export function readAndClearStashedEmail(): string | null {
  try {
    const email = window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY);
    if (email) {
      window.localStorage.removeItem(EMAIL_FOR_LINK_STORAGE_KEY);
    }
    return email;
  } catch {
    return null;
  }
}

/** Peek at the stashed email without clearing it (for the prompt UI). */
export function peekStashedEmail(): string | null {
  try {
    return window.localStorage.getItem(EMAIL_FOR_LINK_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Discard the stashed email (e.g. user clicks "Use a different email"). */
export function clearStashedEmail(): void {
  try {
    window.localStorage.removeItem(EMAIL_FOR_LINK_STORAGE_KEY);
  } catch {
    // Ignore — same rationale as sendMagicLink.
  }
}

/**
 * Complete the email-link round-trip. Caller is responsible for already
 * having confirmed via `isSignInWithEmailLink(href)` that `href` is a
 * valid sign-in link.
 *
 * After the SDK call we run the same bounded-poll claim-refresh as the
 * legacy Google flow used (see module comment).
 */
export async function completeSignInWithEmailLink(email: string, href: string): Promise<User> {
  const result = await signInWithEmailLink(auth, email, href);
  await result.user.getIdToken(true);

  for (let i = 0; i < POLL_ITERATIONS; i++) {
    const { claims } = await result.user.getIdTokenResult();
    if (claims.canonical) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    await result.user.getIdToken(true);
  }

  return result.user;
}
