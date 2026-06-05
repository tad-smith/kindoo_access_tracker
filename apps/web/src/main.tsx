// SPA entrypoint. Wires the provider stack:
//
//   RootErrorBoundary  — catches render-time + Firestore-SDK-panic
//                        errors so the user lands on a fallback page
//                        instead of a blank screen. Outermost so
//                        every React subtree below is covered.
//   QueryClientProvider — TanStack Query cache; required by the DIY
//                          Firestore hooks (lib/data/) which push
//                          snapshots into the cache via setQueryData,
//                          and used directly by mutations + the
//                          one-shot reads in `useFirestoreOnce`.
//     RouterProvider     — TanStack Router renders the matched route.
//                          The Shell layout lives inside the
//                          `_authed` route group so the topbar stays
//                          mounted across navigations.
//
// Per architecture D11: no reactfire providers. Firebase SDK instances
// are module-scoped singletons exported from `lib/firebase.ts`;
// `usePrincipal()` reads from them directly via `onAuthStateChanged`;
// the DIY hooks at `lib/data/` consume them directly via `onSnapshot`
// / `getDoc`.
//
// Imported once and only once. Side-effectful: `lib/firebase` runs
// `initializeApp` + emulator wiring at import time.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
// Side-effectful import — runs initializeApp + emulator wiring before
// any consumer touches the Firebase SDK singletons.
import './lib/firebase';
import { RootErrorBoundary } from './components/RootErrorBoundary';
import { registerServiceWorker } from './lib/pwa/registerServiceWorker';
import { registerNotificationClickRouter } from './features/notifications/serviceWorkerMessenger';
import {
  notifyActiveStakeUrlNavigated,
  registerActiveStakeQueryClient,
} from './lib/useActiveStake';
import { routeTree } from './routeTree.gen';
import './styles/tokens.css';
import './styles/tailwind.css';
import './styles/base.css';
import './styles/pages.css';
// Roster-card rules are shared by AllSeats, Queue, Access, MyRequests, and
// the roster pages. Imported eagerly here (not per-component) so the rules
// ship in the global CSS chunk and land on first paint on every route —
// avoids the route-code-split FOUC that per-component imports caused.
import './components/roster/RosterCardList.css';

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

// Wire TanStack Router's Register interface so the typed `Link`,
// `useNavigate`, etc. resolve against this app's route tree.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Bridge SW notificationclick events to the router so taps on push
// notifications honour the `data.deepLink` payload. iOS standalone
// PWAs ignore `client.navigate()` from inside the SW; the SW posts
// the target back instead and we route on the main thread here.
// No-op when there's no service worker (jsdom tests, Safari paths
// outside the installed PWA).
registerNotificationClickRouter(router);

// Single QueryClient for the app. The DIY Firestore hooks push live
// snapshots into this cache via `setQueryData`; request-response paths
// (mutations, useFirestoreOnce, simple GETs) inherit standard retries
// + backoff. Per-query staleTime can be overridden at the call site.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realistic default for a low-traffic admin app (1–2 requests/week).
      staleTime: 30_000,
    },
  },
});

// Register the QueryClient with the active-stake module so URL-tier
// `?stake=X` hits can invalidate per-stake DIY-Firestore-hook caches.
// `useActiveStake` is consumed at the top of every route gate
// (`useRequireRole`); we keep the QueryClient access module-scoped so
// route-gate unit tests don't need to bring a QueryClientProvider.
registerActiveStakeQueryClient(queryClient);

// Ping the active-stake module on every router-history change so an
// SW notificationclick deep-link push (or any in-app navigation that
// carries `?stake=X`) re-runs the active-stake resolution chain. The
// hook reads `window.location.search` on each ping; no router context
// is required inside the hook.
router.history.subscribe(() => {
  notifyActiveStakeUrlNavigated();
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

// Register the autoUpdate service worker (registerType: 'autoUpdate'). A new
// deploy's worker skip-waits, claims clients, and the page silently reloads
// onto the new bundle on activation — no in-app update prompt. See
// `lib/pwa/registerServiceWorker.ts` for the reload mechanics. Called after
// the first render so SW work never blocks initial paint.
registerServiceWorker();
