// SPA entrypoint. Wires the provider stack:
//
//   FirebaseAppProvider  — gives reactfire the Firebase config
//     FirestoreProvider  — gives reactfire the Firestore SDK instance
//       Suspense         — reactfire's hooks suspend by default
//         RouterProvider — TanStack Router renders the matched route
//
// Imported once and only once. Side-effectful: `lib/firebase` runs
// `initializeApp` + emulator wiring at import time.

import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { FirebaseAppProvider, FirestoreProvider } from 'reactfire';
import { db, firebaseApp, firebaseConfig } from './lib/firebase';
import { router } from './router';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <FirebaseAppProvider firebaseConfig={firebaseConfig} firebaseApp={firebaseApp}>
      <FirestoreProvider sdk={db}>
        <Suspense fallback={<p>Loading&hellip;</p>}>
          <RouterProvider router={router} />
        </Suspense>
      </FirestoreProvider>
    </FirebaseAppProvider>
  </StrictMode>,
);
