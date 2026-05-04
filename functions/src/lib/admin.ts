// Single Admin SDK initialisation point for the Cloud Functions
// codebase. Every trigger / callable / scheduled job that needs
// Firestore or Auth imports `getDb()` / `getAuth()` from here.
//
// We initialise the DEFAULT-named app explicitly. firebase-functions
// v7 internally creates a NAMED app (`__FIREBASE_FUNCTIONS_SDK__`)
// when its providers build snapshots for triggers that don't have a
// default app yet. Picking `getApps()[0]` would silently grab that
// named app, which then breaks `getMessaging()` (and any other
// service that resolves the default app). The right invariant is
// "the [DEFAULT] app exists and we own it" — that's what `ensureApp()`
// enforces.
//
// In the emulator, FIREBASE_CONFIG / FIREBASE_AUTH_EMULATOR_HOST /
// FIRESTORE_EMULATOR_HOST are already injected by the runtime; the
// Admin SDK picks them up automatically. No emulator-specific
// configuration is needed in code.

import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getAuth as adminGetAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { defineString } from 'firebase-functions/params';

// Runtime SA for Sheets-needing functions. Full email — the trailing-@
// shorthand works for runtime-SA assignment but NOT for Firebase CLI's
// secret-IAM-grant step (which uses the literal string as the IAM
// member). Per-project value resolved from `.env.<projectId>`.
export const APP_SA = defineString('APP_SA', {
  default: 'kindoo-app@kindoo-staging.iam.gserviceaccount.com',
});

/** firebase-admin's default-app name; the constant isn't exported. */
const DEFAULT_APP_NAME = '[DEFAULT]';

let app: App | undefined;

function ensureApp(): App {
  if (app) {
    logger.info('[admin.ensureApp] returning cached app', { name: app.name });
    return app;
  }
  const existing = getApps();
  const defaultApp = existing.find((a) => a.name === DEFAULT_APP_NAME);
  logger.info('[admin.ensureApp] no cached app; getApps() snapshot', {
    count: existing.length,
    names: existing.map((a) => a.name),
    hasDefault: defaultApp !== undefined,
  });
  if (defaultApp) {
    app = defaultApp;
    logger.info('[admin.ensureApp] using pre-existing default app', { name: app.name });
  } else {
    logger.info('[admin.ensureApp] no default app; calling initializeApp()');
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
