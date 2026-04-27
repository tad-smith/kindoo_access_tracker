// TanStack Router scaffolding for Phase 1.
//
// One root route at `/` rendering the smoketest Hello page. Phase 4
// converts this to file-based routing under `src/routes/` with typed
// search params via zod. For now we use the code-based API directly so
// the wiring exists end-to-end without committing to file-based layout
// before the rest of the SPA shell exists.

import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Hello } from './pages/Hello';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const helloRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Hello,
});

const routeTree = rootRoute.addChildren([helloRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
