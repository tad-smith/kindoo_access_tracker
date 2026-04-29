// Authenticated-route group. Every page that requires an authenticated
// principal with at least one role lives under the pathless `_authed`
// segment. URLs don't carry `_authed/` — `_authed/manager/dashboard`
// is reachable at `/manager/dashboard`.
//
// Gate logic mirrors `index.tsx`:
//   - No Firebase Auth user → SignInPage.
//   - Auth user but no roles → NotAuthorizedPage.
//   - Auth user + roles → render the child outlet inside the Shell.
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
import { usePrincipal } from '../lib/principal';

export const Route = createFileRoute('/_authed')({
  component: AuthedLayout,
});

function AuthedLayout() {
  const principal = usePrincipal();

  if (!principal.firebaseAuthSignedIn) {
    return <SignInPage />;
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
