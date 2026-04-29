// Authenticated-route group. Every page that requires an authenticated
// principal with at least one role lives under the pathless `_authed`
// segment. URLs don't carry `_authed/` — `_authed/manager/dashboard`
// is reachable at `/manager/dashboard`.
//
// Gate ordering (mirrors `index.tsx`):
//   1. No Firebase Auth user → SignInPage.
//   2. Stake doc loaded with `setup_complete=false`:
//        - The bootstrap admin → BootstrapWizardPage (ignores deep links).
//        - Anyone else who can read the stake doc during this window
//          (managers, by `isAnyMember`) → SetupInProgressPage (distinct
//          from NotAuthorized).
//   3. No role claims → NotAuthorizedPage. We DON'T block this branch
//      on a pending/errored stake-doc read: a no-claims user can't
//      read the stake doc (rules deny), the listener errors, and we'd
//      otherwise sit on a blank page until the error callback fires.
//      Letting NotAuthorized fall through immediately preserves the
//      pre-Phase-7 behavior for that path and avoids race-flake in CI.
//   4. Authenticated with claims, stake-doc still pending → render
//      null briefly to avoid flashing the dashboard before the wizard
//      gate fires (only meaningful for managers; dashboard mount is
//      the normal next step).
//   5. Render the child outlet inside the Shell.
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

function AuthedLayout() {
  const principal = usePrincipal();
  const stake = useFirestoreDoc(principal.firebaseAuthSignedIn ? stakeRef(db, STAKE_ID) : null);

  if (!principal.firebaseAuthSignedIn) {
    return <SignInPage />;
  }

  // Wizard branch fires ONLY when the stake-doc read has resolved with
  // `setup_complete=false`. We don't block rendering on a
  // pending/errored stake-doc read for users who otherwise wouldn't
  // pass this gate (a no-claims user the rules deny — see file header
  // for the race-flake rationale).
  if (stake.data && stake.data.setup_complete === false) {
    const adminCanonical = canonicalEmailFn(stake.data.bootstrap_admin_email ?? '');
    const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');
    if (adminCanonical && meCanonical && adminCanonical === meCanonical) {
      return <BootstrapWizardPage />;
    }
    return <SetupInProgressPage />;
  }

  // No-claims fallback fires regardless of stake-doc read state. Rules
  // deny their read, so we'd otherwise sit on a blank page waiting for
  // the error callback. NotAuthorized lands immediately.
  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }

  // Authenticated principal — wait for the stake-doc read to settle
  // before rendering the Shell, so a manager who is also the bootstrap
  // admin doesn't flash the dashboard before the wizard gate fires.
  if (stake.status === 'pending') {
    return null;
  }

  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
