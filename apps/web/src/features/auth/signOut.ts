// Sign-out entry-point. Thin wrapper around the Firebase Auth SDK.
//
// `usePrincipal()` listens to `onAuthStateChanged`, so the router
// re-renders the SignInPage automatically once `signOut(auth)` resolves.
// Components should call this through a button handler; never invoke
// from inside a render path.

import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../../lib/firebase';

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}
