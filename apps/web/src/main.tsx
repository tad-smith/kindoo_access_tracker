// SPA entrypoint. Wires the provider stack:
//
//   QueryClientProvider — TanStack Query cache; required by the DIY
//                          Firestore hooks (lib/data/) which push
//                          snapshots into the cache via setQueryData.
//   FirebaseAppProvider — gives reactfire the Firebase config
//     AuthProvider       — gives reactfire the Auth SDK instance
//       FirestoreProvider — gives reactfire the Firestore SDK instance
//         Suspense        — reactfire's hooks suspend by default
//           Topbar        — persistent shell above the route outlet
//           RouterProvider — TanStack Router renders the matched route
//
// Phase 3.5 wires `<QueryClientProvider>` in preparation for the
// reactfire → DIY-hooks swap (D11). The reactfire providers stay for
// now; Slice 3 step 2 removes them in a separate commit.
//
// Imported once and only once. Side-effectful: `lib/firebase` runs
// `initializeApp` + emulator wiring at import time.

import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { AuthProvider, FirebaseAppProvider, FirestoreProvider } from 'reactfire';
import { Topbar } from './components/Topbar';
import { auth, db, firebaseApp, firebaseConfig } from './lib/firebase';
import { router } from './router';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element missing from index.html');
}

// Single QueryClient for the app. Defaults are tightened for the
// Firestore-listener path (DIY hooks own their own refetch policy via
// `staleTime: Infinity` on each call); request-response paths
// (TanStack `useMutation`, `useFirestoreOnce`) inherit standard
// retries / backoff.
const queryClient = new QueryClient();

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FirebaseAppProvider firebaseConfig={firebaseConfig} firebaseApp={firebaseApp}>
        <AuthProvider sdk={auth}>
          <FirestoreProvider sdk={db}>
            <Suspense fallback={<p>Loading&hellip;</p>}>
              <Topbar />
              <RouterProvider router={router} />
            </Suspense>
          </FirestoreProvider>
        </AuthProvider>
      </FirebaseAppProvider>
    </QueryClientProvider>
  </StrictMode>,
);
