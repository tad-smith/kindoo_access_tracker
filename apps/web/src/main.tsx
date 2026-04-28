// SPA entrypoint. Wires the provider stack:
//
//   FirebaseAppProvider  — gives reactfire the Firebase config
//     AuthProvider       — gives reactfire the Auth SDK instance
//       FirestoreProvider — gives reactfire the Firestore SDK instance
//         Suspense        — reactfire's hooks suspend by default
//           Topbar        — persistent shell above the route outlet
//           RouterProvider — TanStack Router renders the matched route
//
// Imported once and only once. Side-effectful: `lib/firebase` runs
// `initializeApp` + emulator wiring at import time.

import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { AuthProvider, FirebaseAppProvider, FirestoreProvider } from 'reactfire';
import { Topbar } from './components/Topbar';
import { auth, db, firebaseApp, firebaseConfig } from './lib/firebase';
import { router } from './router';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
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
  </StrictMode>,
);
