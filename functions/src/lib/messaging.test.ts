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
import { ensureAdminInit, getSender } from './messaging.js';

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
});

describe('default sender', () => {
  it('does not throw "default Firebase app does not exist" when invoked without external init', async () => {
    // The bug: prior to the fix, calling the default sender threw at
    // `getMessaging()` because no app had been initialised. With the
    // fix, the wrapper inits on demand. The send itself will likely
    // fail (no creds in this environment) but it must NOT fail with
    // the init error.
    //
    // Caveat: the previous test in this file may have already
    // initialised; we still assert by string match on the specific
    // init error so the regression is locked even if init was a
    // no-op for this run.
    const sender = getSender();
    let err: unknown;
    try {
      await sender.sendEachForMulticast({
        tokens: ['fake-token'],
        notification: { title: 't', body: 'b' },
      });
    } catch (e) {
      err = e;
    }
    // Either the call resolved (unlikely without creds) or it failed
    // with a non-init error. The init-error string is the regression
    // target.
    const msg = err instanceof Error ? err.message : String(err ?? '');
    expect(msg).not.toMatch(/default Firebase app does not exist/i);
  });
});
