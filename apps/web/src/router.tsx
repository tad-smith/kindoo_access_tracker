// TanStack Router scaffolding for Phase 2.
//
// One root route at `/`. Phase 2 adds auth-gating: the route picks one
// of three components based on `usePrincipal()`:
//   - unauthenticated         → SignInPage
//   - authenticated, no role  → NotAuthorizedPage
//   - authenticated + a role  → Hello (Phase-2 placeholder)
//
// Phase 4 converts this to file-based routing under `src/routes/` with
// typed search params via zod and a proper auth-gated route group. For
// now we keep the code-based API so the wiring exists end-to-end
// without committing to file-based layout before the rest of the SPA
// shell exists.

import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { NotAuthorizedPage } from './features/auth/NotAuthorizedPage';
import { SignInPage } from './features/auth/SignInPage';
import { usePrincipal } from './lib/principal';
import { Hello } from './pages/Hello';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

function AuthGate() {
  const principal = usePrincipal();

  // Three-arm gate per Phase 2:
  //   1. Not signed in to Firebase Auth at all → SignInPage.
  //   2. Signed in but no role claims yet → NotAuthorizedPage.
  //   3. Signed in with a role → Hello (Phase-2 placeholder landing).
  // The shared Principal's `isAuthenticated` folds (1)+(2) together —
  // it's true iff the user is signed in AND has at least one role —
  // so we use `firebaseAuthSignedIn` to keep them distinct.
  if (!principal.firebaseAuthSignedIn) {
    return <SignInPage />;
  }
  if (!principal.isAuthenticated) {
    return <NotAuthorizedPage />;
  }
  return <Hello />;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AuthGate,
});

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
