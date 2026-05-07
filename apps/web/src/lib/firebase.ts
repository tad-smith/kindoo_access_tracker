// Firebase SDK initialisation for the Stake Building Access SPA.
//
// One module, one app, one Firestore instance, one Auth instance.
// Imported by main.tsx.
//
// Config comes from VITE_FIREBASE_* env vars (see ../../.env.example). In
// dev (`import.meta.env.DEV`) AND when `VITE_USE_FIRESTORE_EMULATOR` is
// set we point Firestore at the local emulator on 127.0.0.1:8080. The
// Auth emulator is wired analogously via `VITE_USE_AUTH_EMULATOR` (and
// in dev). Same firebase.json that configures `pnpm dev` chooses the
// ports.
//
// `connectFirestoreEmulator` / `connectAuthEmulator` must be called
// before any read/write hits the SDK, so this module is intentionally
// side-effectful at import time.

import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const env = import.meta.env;

// `vite preview` runs the production bundle locally; `import.meta.env.DEV`
// is false there. The Playwright smoke uses preview, so we also honour
// explicit `VITE_USE_*_EMULATOR` flags (set at build time by the e2e
// webServer step).
const useFirestoreEmulator = env.DEV || env.VITE_USE_FIRESTORE_EMULATOR === 'true';
const useAuthEmulator = env.DEV || env.VITE_USE_AUTH_EMULATOR === 'true';
const useFunctionsEmulator = env.DEV || env.VITE_USE_FUNCTIONS_EMULATOR === 'true';

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
export const auth = getAuth(firebaseApp);
// Default-region Functions handle. Callable wrappers consume this via
// the singleton at module load; emulator wiring below has to run before
// the first `httpsCallable(functions, ...)` call.
export const functions = getFunctions(firebaseApp);

// Emulator wiring. We guard against repeat-connection in case HMR
// re-evaluates the module: each SDK throws if you try to point an
// already-connected instance at a different host. The flags live on
// the global because module-level booleans get reset by HMR.
const flagBag = globalThis as unknown as {
  __KINDOO_FIRESTORE_EMULATOR_CONNECTED__?: boolean;
  __KINDOO_AUTH_EMULATOR_CONNECTED__?: boolean;
  __KINDOO_FUNCTIONS_EMULATOR_CONNECTED__?: boolean;
};

if (useFirestoreEmulator && !flagBag.__KINDOO_FIRESTORE_EMULATOR_CONNECTED__) {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  flagBag.__KINDOO_FIRESTORE_EMULATOR_CONNECTED__ = true;
}

if (useAuthEmulator && !flagBag.__KINDOO_AUTH_EMULATOR_CONNECTED__) {
  // `disableWarnings` keeps the dev console quiet about the giant
  // "you are connected to a fake auth service" banner — useful when
  // the e2e suite drives a sign-in popup repeatedly.
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  flagBag.__KINDOO_AUTH_EMULATOR_CONNECTED__ = true;
}

if (useFunctionsEmulator && !flagBag.__KINDOO_FUNCTIONS_EMULATOR_CONNECTED__) {
  // Port 5001 matches `firebase.json` -> emulators.functions.port.
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  flagBag.__KINDOO_FUNCTIONS_EMULATOR_CONNECTED__ = true;
}

// Test-only escape hatch: when running against the Auth emulator we
// expose a small surface on `window.__KINDOO_TEST__` so Playwright
// specs can drive sign-in directly via `page.evaluate`. This avoids
// needing to wire a real Google popup through the test runner. The
// hatch is only opened when the emulator flag is set, so production
// builds never expose it.
if (useAuthEmulator) {
  (
    globalThis as unknown as {
      __KINDOO_TEST__?: {
        signInWithEmailAndPassword: (email: string, password: string) => Promise<void>;
        invokeCallable: (name: string, data: unknown) => Promise<unknown>;
      };
    }
  ).__KINDOO_TEST__ = {
    async signInWithEmailAndPassword(email: string, password: string) {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      // Mirror the production sign-in's force-refresh so claims set by
      // emulator-side `setCustomAttributes` are picked up immediately.
      await credential.user.getIdToken(true);
    },
    // T-25 — direct callable invocation for the install-scheduled-jobs
    // idempotency check. The wizard's "Complete Setup" path can only be
    // walked once (it flips `setup_complete=true` and navigates away);
    // exposing the SDK callable lets the e2e spec invoke a second time
    // to prove no-error-on-rerun without resetting wizard state.
    async invokeCallable(name: string, data: unknown) {
      const fn = httpsCallable(functions, name);
      const res = await fn(data as Record<string, unknown>);
      return res.data;
    },
  };
}

export { firebaseConfig };
