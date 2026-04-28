// SPA entrypoint. Wires the provider stack:
//
//   QueryClientProvider — TanStack Query cache; required by the DIY
//                          Firestore hooks (lib/data/) which push
//                          snapshots into the cache via setQueryData.
//     Topbar              — persistent shell above the route outlet.
//     RouterProvider      — TanStack Router renders the matched route.
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
import { RouterProvider } from '@tanstack/react-router';
import { Topbar } from './components/Topbar';
// Side-effectful import — runs initializeApp + emulator wiring before
// any consumer touches the Firebase SDK singletons.
import './lib/firebase';
import { router } from './router';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element missing from index.html');
}

// Single QueryClient for the app. The DIY Firestore hooks push
// snapshots into this cache; request-response paths (mutations,
// useFirestoreOnce) inherit standard retries / backoff.
const queryClient = new QueryClient();

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Topbar />
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
