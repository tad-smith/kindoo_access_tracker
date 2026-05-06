// Google sign-in entry-point.
//
// Drives the Firebase Auth popup flow against the configured Auth
// instance (which is pointed at the emulator in dev / e2e via
// `apps/web/src/lib/firebase.ts`).
//
// CRITICAL — token-refresh sequencing. After `signInWithPopup` resolves,
// the `onAuthUserCreate` Cloud Function trigger writes
// `userIndex/{canonical}` AND seeds custom claims from any pre-existing
// `kindooManagers/access` rows. That trigger is async (v1
// `auth.user().onCreate`) — it runs in parallel with the client's first
// token refresh. If our refresh lands at the Auth backend before the
// trigger calls `setCustomUserClaims`, the refreshed token has no role
// claims and the user lands on NotAuthorized despite having a valid
// access doc (B-4).
//
// Mitigation — bounded poll-and-refresh after the initial refresh.
// Probe the decoded claims for `canonical` (the field
// `seedClaimsFromRoleData` always sets when the trigger completes); if
// it's missing, sleep 500ms, force-refresh, retry. 10 iterations × 500ms
// caps the wait at 5s. If claims never arrive (trigger crashed, network
// stall, etc.), we still resolve with whatever the last token had —
// the gate downstream handles "no claims → NotAuthorized" the same way
// it always has.

import { GoogleAuthProvider, signInWithPopup, type User } from 'firebase/auth';
import { auth } from '../../lib/firebase';

const POLL_ITERATIONS = 10;
const POLL_INTERVAL_MS = 500;

export async function signIn(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  await result.user.getIdToken(true);

  // Race-window mitigation: poll for the canonical claim with a 5s
  // ceiling. The `onAuthUserCreate` trigger is async; if our first
  // refresh landed before it finished `setCustomUserClaims`, retry
  // until the claim shows up. See module comment.
  for (let i = 0; i < POLL_ITERATIONS; i++) {
    const { claims } = await result.user.getIdTokenResult();
    if (claims.canonical) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    await result.user.getIdToken(true);
  }

  return result.user;
}
