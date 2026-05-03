// Unit tests for the FCM messaging wrapper. The load-bearing case is
// the staging-bug regression: `firebase-admin/messaging` does NOT
// auto-init the default app the way `getFirestore()` does, so the
// wrapper must call `initializeApp()` itself before invoking
// `getMessaging()` in production.
//
// This file imports `messaging.ts` in isolation — no admin-app init
// from a test harness, no transitive Firestore init via
// `lib/admin.ts`. Vitest's default worker isolation gives us a fresh
// module graph per file, so `getApps()` starts empty here.

import { describe, expect, it } from 'vitest';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { ensureAdminInit } from './messaging.js';

describe('ensureAdminInit', () => {
  it('initialises the default app on first call when none exists', () => {
    // Sanity: this file's worker hasn't initialised the admin app yet.
    expect(getApps().length).toBe(0);
    ensureAdminInit();
    expect(getApps().length).toBe(1);
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
});
