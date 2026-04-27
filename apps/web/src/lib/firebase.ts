// Firebase SDK initialisation for the Kindoo SPA.
//
// One module, one app, one Firestore instance. Imported by main.tsx.
//
// Config comes from VITE_FIREBASE_* env vars (see ../../.env.example). In
// dev (`import.meta.env.DEV`) AND when `VITE_USE_FIRESTORE_EMULATOR`
// is set we point Firestore at the local emulator on 127.0.0.1:8080 —
// the same port firebase.json configures for `pnpm dev`.
//
// `connectFirestoreEmulator` must be called before any read/write hits
// the SDK, so this module is intentionally side-effectful at import
// time.

import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

const env = import.meta.env;

// `vite preview` runs the production bundle locally; `import.meta.env.DEV`
// is false there. The Playwright smoke uses preview, so we also honour an
// explicit `VITE_USE_FIRESTORE_EMULATOR` flag (set at build time by the
// e2e webServer step).
const useEmulator = env.DEV || env.VITE_USE_FIRESTORE_EMULATOR === 'true';

// Vite's `ImportMetaEnv` types VITE_* vars as `any`, so this assigns
// cleanly under `exactOptionalPropertyTypes: true` (set in
// tsconfig.base.json). For the emulator path, `projectId` is the only
// required field — Firestore accepts whatever the emulator gave us at
// `connectFirestoreEmulator` time.
const firebaseConfig: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'fake-api-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'kindoo-staging',
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);

// Emulator wiring. We guard against repeat-connection in case HMR
// re-evaluates the module: the SDK throws if you try to point an already-
// connected Firestore at a different host. The flag lives on the global
// because module-level booleans get reset by HMR.
if (useEmulator) {
  const flagBag = globalThis as unknown as {
    __KINDOO_FIRESTORE_EMULATOR_CONNECTED__?: boolean;
  };
  if (!flagBag.__KINDOO_FIRESTORE_EMULATOR_CONNECTED__) {
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    flagBag.__KINDOO_FIRESTORE_EMULATOR_CONNECTED__ = true;
  }
}

export { firebaseConfig };
