// Google sign-in entry-point.
//
// Drives the Firebase Auth popup flow against the configured Auth
// instance (which is pointed at the emulator in dev / e2e via
// `apps/web/src/lib/firebase.ts`).
//
// CRITICAL — token-refresh sequencing. After `signInWithPopup` resolves,
// the `onAuthUserCreate` Cloud Function trigger writes
// `userIndex/{canonical}` AND seeds custom claims from any pre-existing
// `kindooManagers/access` rows. Those claim writes fan out via
// `setCustomUserClaims` + `revokeRefreshTokens`. The Auth-SDK ID token
// the popup just minted is *stale* relative to those claims, so we
// force-refresh it via `getIdToken(true)` before returning. This is the
// only way the first authenticated read sees the freshly-seeded role
// claims (`stakes[sid].manager`, etc.) without waiting up to an hour
// for the SDK's idle refresh.
//
// The migration plan (Phase 2 sub-tasks) calls this out explicitly. If
// you remove the refresh, `usePrincipal()` will return an unauthorized
// shape on first sign-in even when role claims should resolve.

import { GoogleAuthProvider, signInWithPopup, type User } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export async function signIn(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  // Force-refresh so claims set by `onAuthUserCreate` land on the token
  // before the next authenticated request. See module comment.
  await result.user.getIdToken(true);
  return result.user;
}
