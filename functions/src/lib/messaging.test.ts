// Unit tests for the FCM messaging wrapper. Two regression cases:
//
//   1. `firebase-admin/messaging`'s `getMessaging()` does NOT auto-init
//      the default app the way `getFirestore()` does. Without explicit
//      `initializeApp()`, the wrapper must do it.
//
//   2. firebase-functions v7 internally creates a NAMED app
//      (`__FIREBASE_FUNCTIONS_SDK__`) when its providers build a
//      snapshot for an `onDocumentCreated` trigger and no default app
//      exists yet. That makes `getApps()` non-empty BUT the default app
//      is still missing, so `getMessaging()` still throws. The wrapper
//      check is "default-named app exists?", not "any app exists?".
//
// This file imports `messaging.ts` in isolation — no admin-app init
// from a test harness, no transitive Firestore init via
// `lib/admin.ts`. Vitest's default worker isolation gives us a fresh
// module graph per file, so `getApps()` starts empty here.

import { describe, expect, it } from 'vitest';
import { deleteApp, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { ensureAdminInit } from './messaging.js';

const FIREBASE_FUNCTIONS_APP_NAME = '__FIREBASE_FUNCTIONS_SDK__';

describe('ensureAdminInit', () => {
  it('initialises the default app on first call when none exists', () => {
    // Sanity: this file's worker hasn't initialised the admin app yet.
    expect(getApps().length).toBe(0);
    ensureAdminInit();
    expect(getApps().some((a) => a.name === '[DEFAULT]')).toBe(true);
  });

  it('is idempotent — re-calling does not throw or duplicate the app', () => {
    ensureAdminInit();
    const beforeLen = getApps().length;
    ensureAdminInit();
    ensureAdminInit();
    expect(getApps().length).toBe(beforeLen);
  });

  it('lets `getMessaging()` resolve the default app — staging-bug regression', () => {
    // The staging bug: `getMessaging()` threw "The default Firebase
    // app does not exist" because no `initializeApp()` had run. With
    // the fix the wrapper inits on demand; once `ensureAdminInit()`
    // has run, `getMessaging()` synchronously returns a client.
    //
    // We don't exercise `sendEachForMulticast()` here because that
    // resolves credentials and round-trips to FCM — neither available
    // in CI. The init-error fault is at `getMessaging()` itself, so
    // that's where we assert.
    ensureAdminInit();
    expect(() => getMessaging()).not.toThrow();
  });

  it('creates the default app when only a NAMED app exists (firebase-functions case)', async () => {
    // Reset state so this test doesn't see the default app the prior
    // tests created. Then init a non-default named app — the same
    // shape `firebase-functions/common/app.mjs` builds when a trigger
    // fires before any user-code init.
    for (const a of [...getApps()]) {
      await deleteApp(a);
    }
    expect(getApps().length).toBe(0);
    initializeApp({}, FIREBASE_FUNCTIONS_APP_NAME);
    expect(getApps().length).toBe(1);
    expect(getApps().some((a) => a.name === '[DEFAULT]')).toBe(false);

    ensureAdminInit();

    // Default app now present alongside the named one. Crucially,
    // `getApp()` (default) resolves — which is what `getMessaging()`
    // calls under the hood.
    expect(getApps().some((a) => a.name === '[DEFAULT]')).toBe(true);
    expect(() => getApp()).not.toThrow();
  });
});
