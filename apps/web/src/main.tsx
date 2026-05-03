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
// Phase 3.5 (D11): reactfire's FirebaseAppProvider / AuthProvider /
// FirestoreProvider are gone. Firebase SDK instances are module-scoped
// singletons exported from `lib/firebase.ts`; `usePrincipal()` reads
// from them directly via `onAuthStateChanged`; the DIY hooks at
// `lib/data/` consume them directly via `onSnapshot` / `getDoc`.
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
import { PwaUpdatePrompt } from './components/layout/PwaUpdatePrompt';
import { registerNotificationClickRouter } from './features/notifications/serviceWorkerMessenger';
import { routeTree } from './routeTree.gen';
import './styles/tokens.css';
import './styles/tailwind.css';
import './styles/base.css';
import './styles/pages.css';

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
      {/* Mounted at the root so SW registers regardless of auth state
          and the update prompt survives auth/route transitions. */}
      <PwaUpdatePrompt />
    </RootErrorBoundary>
  </StrictMode>,
);
