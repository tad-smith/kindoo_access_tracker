// Authenticated-route group. Every page that requires an authenticated
// principal with at least one role lives under the pathless `_authed`
// segment. URLs don't carry `_authed/` — `_authed/manager/dashboard`
// is reachable at `/manager/dashboard`.
//
// Gate logic mirrors `index.tsx`:
//   - No Firebase Auth user → SignInPage.
//   - Stake exists with `setup_complete=false`:
//       - The bootstrap admin → BootstrapWizardPage (ignores deep links).
//       - Anyone else → SetupInProgressPage (distinct from NotAuthorized).
//   - Auth user but no roles → NotAuthorizedPage.
//   - Auth user + roles → render the child outlet inside the Shell.
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

  // Bootstrap gate runs before role resolution. While the stake doc
  // subscription is still pending, render nothing rather than flashing
  // the NotAuthorized page. Once the snapshot lands `status` flips to
  // 'success' and we route based on `setup_complete` (or fall through
  // when the doc is absent — that's the pre-superadmin-bootstrap state
  // and the user lands on NotAuthorized; the createStake callable
  // creates the stake doc with `setup_complete=false`).
  if (stake.status === 'pending') {
    return null;
  }
  if (stake.data && stake.data.setup_complete === false) {
    const adminCanonical = canonicalEmailFn(stake.data.bootstrap_admin_email ?? '');
    const meCanonical = principal.canonical ?? canonicalEmailFn(principal.email ?? '');
    if (adminCanonical && meCanonical && adminCanonical === meCanonical) {
      return <BootstrapWizardPage />;
    }
    return <SetupInProgressPage />;
  }

  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
