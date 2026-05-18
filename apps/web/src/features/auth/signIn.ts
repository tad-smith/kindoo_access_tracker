// Sign-in helpers — both providers the SPA exposes (spec §4.1).
//
// Two surfaces share a single Firebase Auth instance and a single
// `userIndex/{canonical}` doc:
//
//   1. Google popup — `signInWithGoogle()` drives `signInWithPopup` with
//      `GoogleAuthProvider`. Used by the "Continue with Google" CTA on
//      the SignInPage.
//   2. Email magic link — `sendMagicLink()` calls
//      `sendSignInLinkToEmail` and stashes the typed email in
//      localStorage; the emailed link lands on the action-handler route
//      under `/auth/email-link`, which calls `completeSignInWithEmailLink`
//      to finish the round-trip.
//
// With Firebase Auth's "one account per email address" project setting
// (Console → Authentication → Settings → User account linking) both
// providers end at the same Firebase UID for the same email, so the
// downstream `userIndex` / claim-sync triggers are provider-agnostic.
//
// CRITICAL — token-refresh sequencing. After either flow resolves,
// the `onAuthUserCreate` Cloud Function trigger writes
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
// it always has. Both `signInWithGoogle` and `completeSignInWithEmailLink`
// share the same bounded-poll implementation.

import {
  GoogleAuthProvider,
  isSignInWithEmailLink as fbIsSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
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
 * The email is passed through to the SDK verbatim (after the form-
 * level trim + zod validation). It is NOT canonicalised here: the root
 * CLAUDE.md "canonicalise every email" rule applies to Firestore-keyed
 * data (`userIndex/{canonical}`, `access/{canonical}`,
 * `kindooManagers/{email}` — see spec §2 / §4), not to the Firebase
 * Auth API boundary. Firebase Auth treats stored emails as case-
 * insensitive opaque strings — it does NOT apply Gmail dot/+ collapse,
 * and its "one account per email address" project setting only auto-
 * links byte-equal stored values. Canonicalising before the SDK call
 * would break AC #8: if the operator's existing Google sign-in stored
 * `tad.e.smith@gmail.com`, canonicalising a magic-link entry to
 * `tadesmith@gmail.com` would mint a fresh Firebase UID and the
 * `onAuthUserCreate` trigger would overwrite `userIndex/{canonical}`
 * to point at it, orphaning the original Google-minted UID.
 *
 * Spec §4.1 step 2 also calls out the typed email is what's stashed.
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
 * Bounded poll-and-refresh for the `canonical` custom claim. See module
 * comment for the B-4 race-window mitigation. Shared by both sign-in
 * surfaces (`signInWithGoogle` + `completeSignInWithEmailLink`).
 */
async function pollForCanonicalClaim(user: User): Promise<void> {
  await user.getIdToken(true);
  for (let i = 0; i < POLL_ITERATIONS; i++) {
    const { claims } = await user.getIdTokenResult();
    if (claims.canonical) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    await user.getIdToken(true);
  }
}

/**
 * Sign in via the Google OAuth popup. Surfaces the "Continue with
 * Google" CTA on the SignInPage; pairs with the magic-link form below
 * it. Firebase Auth's "one account per email address" project setting
 * means both surfaces resolve to the same UID for the same email.
 *
 * Throws (via the SDK) on:
 *   - `auth/popup-closed-by-user` — user dismissed the popup.
 *   - `auth/popup-blocked` — browser-level popup blocker.
 *   - `auth/network-request-failed` — transient.
 *   - `auth/cancelled-popup-request` — second popup raced.
 */
export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  await pollForCanonicalClaim(result.user);
  return result.user;
}

/**
 * Complete the email-link round-trip. Caller is responsible for already
 * having confirmed via `isSignInWithEmailLink(href)` that `href` is a
 * valid sign-in link.
 *
 * `email` is passed through to `signInWithEmailLink` verbatim. Same
 * rationale as `sendMagicLink`: the Firebase Auth API boundary is NOT
 * a Firestore-keyed input, so the root CLAUDE.md "canonicalise every
 * email" rule does not apply here. Firebase Auth requires the same
 * (case-insensitive) byte string at both halves of the round-trip; a
 * mismatch surfaces as `auth/invalid-email` from the SDK.
 *
 * After the SDK call we run the same bounded-poll claim-refresh as the
 * Google flow (see module comment).
 */
export async function completeSignInWithEmailLink(email: string, href: string): Promise<User> {
  const result = await signInWithEmailLink(auth, email, href);
  await pollForCanonicalClaim(result.user);
  return result.user;
}
