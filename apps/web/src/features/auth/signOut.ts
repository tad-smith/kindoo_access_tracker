// Sign-out entry-point. Thin wrapper around the Firebase Auth SDK.
//
// `usePrincipal()` listens to `onAuthStateChanged`, so the router
// re-renders the SignInPage automatically once `signOut(auth)` resolves.
// Components should call this through a button handler; never invoke
// from inside a render path.
//
// Also clears both `kindoo.activeStake` storage tiers (B-19). Without
// this, a stale/invalidated entry survives sign-out and either (a)
// permanently shadows the NEXT sign-in's resolution on this device — a
// zero-role principal who's since become bootstrap admin of a different
// stake would otherwise keep resolving to the old stake and permission-
// denying forever — or (b) leaks one user's stake selection into the
// next user's session on a shared browser. This trades away sticky-
// stake persistence across a sign-out/sign-in cycle for the SAME user;
// that's the correct trade given (a) and (b), but it is a behaviour
// change worth flagging: re-signing-in no longer resumes the
// previously-active stake, it re-resolves from claims (tier 4).
// Cleared BEFORE the Firebase Auth sign-out call so it happens even if
// that call fails partway through.

import { signOut as firebaseSignOut } from 'firebase/auth';
import { clearActiveStakeStorage } from '../../lib/activeStake';
import { auth } from '../../lib/firebase';

export async function signOut(): Promise<void> {
  clearActiveStakeStorage();
  await firebaseSignOut(auth);
}
