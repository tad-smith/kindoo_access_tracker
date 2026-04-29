// Authenticated-route group. Every page that requires an authenticated
// principal with at least one role lives under the pathless `_authed`
// segment. URLs don't carry `_authed/` — `_authed/manager/dashboard`
// is reachable at `/manager/dashboard`.
//
// Gate ordering per `docs/firebase-migration.md` §Phase 7
// "Setup-complete gate" (mirrors `index.tsx`):
//   1. No Firebase Auth user → SignInPage.
//   2. Stake doc loaded with `setup_complete=false`:
//        a. Bootstrap admin (token email matches stake.bootstrap_admin_email)
//           → BootstrapWizardPage (ignores deep links).
//        b. Anyone else → SetupInProgressPage. **SetupInProgress takes
//           precedence over NotAuthorized during setup**, including
//           users with zero claims — the spec says non-admins during
//           bootstrap aren't unauthorised, the app simply isn't ready
//           yet for them. This requires the parent stake doc be
//           readable by any authed user during `setup_complete=false`
//           (rules clause: see firestore.rules `match /stakes/{sid}`).
//   3. Stake doc loaded with `setup_complete=true` (post-setup) and no
//      role claims → NotAuthorizedPage.
//   4. Stake-doc subscription unresolved (pending or errored) for a
//      no-claims user → render NotAuthorizedPage immediately. The
//      Firestore listener may take seconds to fire its error callback
//      under permission-denied; we don't wait. If the user is
//      genuinely the rare "non-admin during setup" case (rule allows
//      their read), the snapshot lands shortly and re-renders into
//      SetupInProgress. The brief NotAuthorized flash is acceptable;
//      a 5+ second blank page is not.
//   5. Authenticated principal with claims, stake-doc still pending →
//      render null briefly so a manager who is also the bootstrap
//      admin doesn't flash the dashboard before the wizard gate fires.
//   6. Render the child outlet inside the Shell.
//
// We don't use TanStack Router's `beforeLoad` redirect for the gate
// because `usePrincipal()` is a React hook (it subscribes to Firebase
// Auth's `onAuthStateChanged` and decodes ID-token claims through the
// React lifecycle); it's only callable inside the React tree. Doing
// the gate in the component is correct here.

import { Outlet, createFileRoute } from '@tanstack/react-router';
import { canonicalEmail as canonicalEmailFn } from '@kindoo/shared';
import { Shell } from '../components/layout/Shell';
import { SignInPage } from '../features/auth/SignInPage';
import { NotAuthorizedPage } from '../features/auth/NotAuthorizedPage';
import { SetupInProgressPage } from '../features/auth/SetupInProgressPage';
import { BootstrapWizardPage } from '../features/bootstrap/BootstrapWizardPage';
import { usePrincipal } from '../lib/principal';
import { useFirestoreDoc } from '../lib/data';
import { stakeRef } from '../lib/docs';
import { db } from '../lib/firebase';
import { STAKE_ID } from '../lib/constants';

export const Route = createFileRoute('/_authed')({
  component: AuthedLayout,
});

// Exported for component-tests to drive the gate directly without
// rebuilding TanStack Router's file-based-route plumbing.
export function AuthedLayout() {
  const principal = usePrincipal();
  const stake = useFirestoreDoc(principal.firebaseAuthSignedIn ? stakeRef(db, STAKE_ID) : null);

  if (!principal.firebaseAuthSignedIn) {
    return <SignInPage />;
  }

  // Setup gate fires whenever the stake doc has loaded with
  // `setup_complete=false`. Bootstrap admin → wizard; everyone else
  // → SetupInProgress (precedence over NotAuthorized per spec §10).
  if (stake.data && stake.data.setup_complete === false) {
    const adminCanonical = canonicalEmailFn(stake.data.bootstrap_admin_email ?? '');
    const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');
    if (adminCanonical && meCanonical && adminCanonical === meCanonical) {
      return <BootstrapWizardPage />;
    }
    return <SetupInProgressPage />;
  }

  // No-claims users land on NotAuthorized immediately, regardless of
  // stake-doc subscription state. We don't block on `pending` here —
  // Firestore's permission-denied listener errors can take seconds to
  // fire in CI, and a noclaims user in the post-setup case is the
  // common path. If the rare "non-admin during setup" case is real,
  // the stake-doc snapshot lands shortly (rules allow), and the gate
  // above re-renders into SetupInProgress.
  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }

  // Authenticated principal — wait for the stake-doc subscription to
  // settle before rendering the Shell, so a manager who is also the
  // bootstrap admin doesn't flash the dashboard before the wizard
  // gate above fires.
  if (stake.status === 'pending') {
    return null;
  }

  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
