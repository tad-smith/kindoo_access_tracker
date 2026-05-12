// Authenticated-route group. Every page that requires an authenticated
// principal with at least one role lives under the pathless `_authed`
// segment. URLs don't carry `_authed/` — `_authed/manager/dashboard`
// is reachable at `/manager/dashboard`.
//
// Gate ordering per `docs/spec.md` §10. The branch picker is
// `gateDecision()` in `lib/setupGate.ts` — same module powers
// `routes/index.tsx` so the two gates can never drift. See that
// module's header for the full rule table; the short version:
//
//   1. No Firebase Auth user                → SignInPage.
//   2. Stake-doc subscription pending       → render null.
//   3. Stake doc loaded with setup_complete !== true (incl. doc absent
//      and missing field — Option A from the bug report):
//        a. Token email matches stake.bootstrap_admin_email →
//           BootstrapWizardPage (ignores deep links).
//        b. Otherwise (incl. claim-bearing users) →
//           SetupInProgressPage. Setup precedence over both
//           Dashboard and NotAuthorized is the staging-bug fix.
//   4. Stake doc loaded with setup_complete === true:
//        a. No role claims → NotAuthorizedPage.
//        b. Otherwise      → render the Shell + child Outlet.
//
// We don't use TanStack Router's `beforeLoad` redirect for the gate
// because `usePrincipal()` is a React hook (it subscribes to Firebase
// Auth's `onAuthStateChanged` and decodes ID-token claims through the
// React lifecycle); it's only callable inside the React tree. Doing
// the gate in the component is correct here.

import { Outlet, createFileRoute } from '@tanstack/react-router';
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
import { gateDecision } from '../lib/setupGate';

export const Route = createFileRoute('/_authed')({
  component: AuthedLayout,
});

// Exported for component-tests to drive the gate directly without
// rebuilding TanStack Router's file-based-route plumbing.
export function AuthedLayout() {
  const principal = usePrincipal();
  const stake = useFirestoreDoc(principal.firebaseAuthSignedIn ? stakeRef(db, STAKE_ID) : null);

  const decision = gateDecision(principal, { data: stake.data, status: stake.status });

  switch (decision) {
    case 'sign-in':
      return <SignInPage />;
    case 'pending':
      // Stake-doc subscription hasn't yielded a snapshot yet. Render
      // null so a manager who is also the bootstrap admin doesn't
      // flash the dashboard before the wizard gate fires, AND so a
      // non-admin during bootstrap doesn't briefly flash NotAuthorized
      // before re-rendering into SetupInProgress.
      return null;
    case 'wizard':
      return <BootstrapWizardPage />;
    case 'setup-in-progress':
      return <SetupInProgressPage />;
    case 'not-authorized':
      return <NotAuthorizedPage />;
    case 'authed':
      return (
        <Shell>
          <Outlet />
        </Shell>
      );
  }
}
