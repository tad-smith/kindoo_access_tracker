// Root route. Always rendered; wraps every page in the shared
// `<Outlet />`. We deliberately keep this thin — TanStack Query is
// the only React-context provider in `main.tsx`; Firebase SDK
// instances are module-scoped singletons consumed directly from
// `lib/firebase.ts` (per architecture D11).
//
// Sign-in gating happens in the `_authed` layout route, not here. The
// root path renders unauthenticated visitors via `index.tsx`'s gate.

import { Outlet, createRootRoute } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: RootRoute,
});

function RootRoute() {
  return <Outlet />;
}
