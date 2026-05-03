// Single Admin SDK initialisation point for the Cloud Functions
// codebase. Every trigger / callable / scheduled job that needs
// Firestore or Auth imports `getDb()` / `getAuth()` from here.
//
// `initializeApp()` must be called exactly once per process; calling
// twice throws. Module-load time is the natural single-call site,
// since the Cloud Functions runtime keeps each instance's modules
// loaded for the lifetime of the container.
//
// In the emulator, FIREBASE_CONFIG / FIREBASE_AUTH_EMULATOR_HOST /
// FIRESTORE_EMULATOR_HOST are already injected by the runtime; the
// Admin SDK picks them up automatically. No emulator-specific
// configuration is needed in code.

import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth as adminGetAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';

// Runtime SA for Sheets-needing functions; firebase-functions appends the
// active project at deploy time so the same value works in staging + prod.
export const APP_SA = 'kindoo-app@';

let app: App | undefined;

function ensureApp(): App {
  if (app) {
    logger.info('[admin.ensureApp] returning cached app', { name: app.name });
    return app;
  }
  const existing = getApps();
  logger.info('[admin.ensureApp] no cached app; getApps() length', {
    count: existing.length,
    names: existing.map((a) => a.name),
  });
  if (existing.length > 0) {
    app = existing[0] as App;
    logger.info('[admin.ensureApp] using pre-existing app', { name: app.name });
  } else {
    logger.info('[admin.ensureApp] calling initializeApp()');
    app = initializeApp();
    logger.info('[admin.ensureApp] initializeApp() returned', { name: app.name });
  }
  return app;
}

/** Lazy Firestore handle. Use this everywhere instead of constructing your own. */
export function getDb(): Firestore {
  return getFirestore(ensureApp());
}

/** Lazy Auth handle. Use this everywhere instead of constructing your own. */
export function getAdminAuth(): Auth {
  return adminGetAuth(ensureApp());
}
